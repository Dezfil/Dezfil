---
title: "Reverse proxy and HTTPS"
summary: "Serve Dezfil at your own domain over HTTPS, with Caddy or nginx in front of it."
read_when:
  - "you want people to reach Dezfil at your own domain over HTTPS"
  - "you put Caddy or nginx in front of Dezfil"
  - "you need to know what to set DEZFIL_TRUSTED_PROXIES to"
  - "sign-in works on the server but fails through your domain"
  - "uploads, long imports or the assistant's answers fail or stall behind nginx"
audience:
  - operator
checked: none
order: 2
---

Put Caddy or nginx in front of Dezfil to serve it at your own domain over HTTPS. The proxy holds the certificate and passes each request to Dezfil, which serves plain HTTP on port 3000.

- **You need:** Dezfil running in Docker as [Install](../start/install.md) sets it up, on port 3000 of `127.0.0.1` only.
- **A domain:** a domain or subdomain of its own, such as `maps.example.com`, whose DNS record points at the server. Dezfil serves from the root of its address, not from a path such as `example.com/maps/`.
- **The proxy:** Caddy, or nginx and certbot, installed on the same server, with ports 80 and 443 open to the internet.

## 1. Set up the proxy

> [!WARNING]
> The first person to finish setup becomes the admin. If you have no account yet, create it before your domain goes live: run `ssh -L 3000:127.0.0.1:3000 <YOUR_SERVER>` on your computer, then open <http://localhost:3000>.

::::tabs

:::tab[Caddy]

Put this site in `/etc/caddy/Caddyfile`, in place of the example site:

```text title="/etc/caddy/Caddyfile"
<YOUR_DOMAIN> {
	reverse_proxy 127.0.0.1:3000 {
		header_up -Forwarded
		header_up -X-Forwarded-Port
	}
}
```

- `<YOUR_DOMAIN>` is your domain, such as `maps.example.com`. Caddy gets a certificate for it by itself and sends plain HTTP visitors to HTTPS.
- `reverse_proxy 127.0.0.1:3000` passes every request to Dezfil, with the visitor's address, host and scheme in forwarding headers.
- The two `header_up` lines drop forwarding headers that Caddy would otherwise pass on from the visitor unchanged. Dezfil takes what a trusted proxy sends as true.

Load the new file:

```sh title="Terminal"
sudo systemctl reload caddy
```

Caddy passes uploads and the assistant's answers through as they arrive, and sets no time limit on an answer, so the site needs nothing more.

:::

:::tab[nginx]

Save this file as `/etc/nginx/conf.d/dezfil.conf`:

```nginx title="/etc/nginx/conf.d/dezfil.conf"
server {
    listen 80;
    server_name <YOUR_DOMAIN>;

    client_max_body_size 0;
    proxy_read_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header Forwarded "";
    }
}
```

- `client_max_body_size 0` leaves the size of an upload to Dezfil's **Largest upload**, 5,120 MB by default ([Limits](../api/limits.md)). Without it, nginx refuses anything over 1 MB.
- `proxy_read_timeout 3600s` waits up to an hour for an answer, as long as Dezfil's **Data processing time limit** allows an import by default.
- The two buffering lines pass uploads and the assistant's answers through as they arrive.
- The `proxy_set_header` lines send the visitor's address, host, scheme and port, and drop a `Forwarded` header a visitor could add.

Check the file:

```sh title="Terminal"
sudo nginx -t
```

```text title="Output"
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

Load it, then get a certificate with certbot and its nginx plugin:

```sh title="Terminal"
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d <YOUR_DOMAIN>
```

- `--nginx` gets a certificate from Let's Encrypt and adds HTTPS to the server block above.
- `--redirect` sends plain HTTP visitors to HTTPS.

:::

::::

## 2. Trust the proxy

Dezfil reads the visitor's address and scheme from the proxy's headers only when the connection comes from an address you trust.

With the proxy on the server and Dezfil in Docker, Dezfil sees the proxy's requests arrive from the gateway of the container's network. Print it:

```sh title="Terminal"
docker inspect --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' dezfil
```

```text title="Output"
172.17.0.1
```

With Docker Compose the address differs, such as `172.18.0.1`. If Dezfil runs on the server itself, outside Docker, the address is `127.0.0.1`.

Start Dezfil again with that address in `DEZFIL_TRUSTED_PROXIES`:

::::tabs

:::tab[Docker]

```sh title="Terminal"
docker rm -f dezfil
docker run -d --name dezfil -p 127.0.0.1:3000:3000 -v dezfil-data:/data \
  -e DEZFIL_TRUSTED_PROXIES=<PROXY_ADDRESS> \
  dezfil
```

Add the other `-e` variables you use, such as the assistant's key. The `dezfil-data` volume keeps your data.

:::

:::tab[Docker Compose]

Add the variable to the service in your `compose.yaml`:

```yaml title="compose.yaml"
services:
  dezfil:
    environment:
      DEZFIL_TRUSTED_PROXIES: "<PROXY_ADDRESS>"
```

Then run `docker compose up -d`. Compose replaces the container and keeps the volume.

:::

::::

From a trusted address, Dezfil reads:

- **The visitor's address:** from `X-Forwarded-For` or `Forwarded`, the nearest address that is not trusted. Dezfil counts failed sign-ins and requests to published maps per address.
- **The scheme, host and port:** from `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Port`. Dezfil checks that each change a browser makes comes from its own pages at that address, and builds the sign-in links **Users** hands out with it.
- **HTTPS:** when the scheme is `https`, Dezfil marks its session cookie as secure, so the browser sends it only over HTTPS.

From any other address, Dezfil drops these headers and uses the connection itself: the proxy's address and plain HTTP. Sign-in through your domain then fails, and all visitors share one address's limits.

> [!WARNING]
> Anyone who connects from a trusted address can hand Dezfil any visitor address and scheme. List only your proxy, and keep Dezfil's port on `127.0.0.1` so visitors reach it only through the proxy.

## 3. Check it

```sh title="Terminal"
curl https://<YOUR_DOMAIN>/api/health
```

```json title="Output"
{"status":"ready"}
```

1. Open `https://<YOUR_DOMAIN>` and sign in with your **Email** and **Password**. You should see **Home**.
2. As an admin, open **Settings** › **System**. In the **Server settings** card, you should see the **Trusted proxies** row with your proxy's address and the **Source** **Environment**.

## Trusted proxies

Set `DEZFIL_TRUSTED_PROXIES` to the address Dezfil sees your proxy's requests arrive from, and have the proxy send the visitor's address, host and scheme, as steps 1 and 2 do.

<!-- settings-proxies:start -->

| Setting | Variable | Settings key | Default | Values | What it does | Changes |
|---|---|---|---|---|---|---|
| **Trusted proxies** | `DEZFIL_TRUSTED_PROXIES` |  | unset | IP addresses or CIDR networks, separated by commas or spaces; a host name stops the server at start | Socket peers allowed to supply forwarding information. | By variable, after a restart |
| **Session cookie name** | `DEZFIL_SESSION_COOKIE` |  | port-based | ASCII letters, digits and ``!#$%&'*+-.^_`\|~``; any other value stops the server at start | Browser session cookie name, derived from the listening port unless overridden. | By variable, after a restart |

<!-- settings-proxies:end -->

## Troubleshooting

### Sign-in fails with "This request must come from the same instance."

Dezfil reads its own address differently from your browser, most often `http` where the browser has `https`.

Run the `docker inspect` command of step 2 again: `DEZFIL_TRUSTED_PROXIES` must hold the address it prints. Then check that the proxy sends the headers of step 1.

### Your domain sends the browser to `127.0.0.1:3000`

nginx sends its own upstream address as the host. Add the `proxy_set_header Host` and `X-Forwarded-Host` lines of step 1, then reload nginx.

### Pages show `{"error":{"code":"invalid_request","message":"Invalid request provenance."}}`

A trusted proxy sent forwarding headers that disagree, such as a `Forwarded` header beside different `X-Forwarded-*` values. Drop `Forwarded` at the proxy as step 1 does, and let one proxy set the `X-Forwarded-*` headers.

### Dezfil stops or restarts right after it starts

`docker logs dezfil` shows `Error: Invalid ingress address` or `Error: Invalid trusted proxy network`. `DEZFIL_TRUSTED_PROXIES` takes IP addresses and networks such as `172.17.0.0/16`, separated by commas. A host name is refused.

### Uploads over 1 MB fail behind nginx

nginx refuses larger requests unless told otherwise. Add `client_max_body_size 0;` to the server block, then reload nginx.

### Long imports or queries fail after a minute behind nginx

nginx answers `504 Gateway Time-out` when Dezfil takes over 60 seconds to answer. Add `proxy_read_timeout 3600s;`, then reload nginx.

### The assistant's answer arrives in bursts behind nginx

nginx holds the answer back until its buffers fill. Add `proxy_buffering off;`, then reload nginx.

## Next steps

- [Configuration](configuration.md): set other variables, and see the values in effect.
- [What leaves the instance](what-leaves-the-instance.md): every outside request your instance can make.
