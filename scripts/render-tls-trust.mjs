// Host-only prerequisites. The image and Node's crypto API cannot mint these.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
const execute = promisify(execFile);
export async function provisionTrust(directory) {
  await mkdir(directory);
  const run = (file, args) => execute(file, args, { cwd: directory, timeout: 30_000 });
  await run('openssl', ['version']);
  // Fail early if the host lacks the NSS tool. Never fall back to ignoring TLS.
  await run('certutil', ['-H']).catch(error => { if (error.code === 'ENOENT') throw error; });
  const ca = async name => {
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', `/CN=Render probe ${name}`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', `${name}.key`, '-out', `${name}.pem`]);
  };
  await ca('root'); await ca('untrusted-root');
  async function issue(name, issuer, extensions) {
    await run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    await writeFile(path.join(directory, `${name}.ext`), extensions);
    await run('openssl', ['x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial',
      '-days', '2', '-sha256', '-extfile', `${name}.ext`, '-out', `${name}.pem`]);
  }
  const leaf = host => `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${host}\n`;
  await issue('trusted', 'root', leaf('tls.render.test'));
  await issue('untrusted', 'untrusted-root', leaf('tls.render.test'));
  await issue('wrong-host', 'root', leaf('other.render.test'));
  await issue('intermediate', 'root', 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  await issue('incomplete', 'intermediate', leaf('tls.render.test') + 'authorityInfoAccess=caIssuers;URI:http://aia.render.test:8080/intermediate.der\n');
  await run('openssl', ['x509', '-in', 'intermediate.pem', '-outform', 'DER', '-out', 'intermediate.der']);
  await writeFile(path.join(directory, 'node-ca.pem'), (await Promise.all(['root', 'untrusted-root', 'intermediate'].map(name => readFile(path.join(directory, `${name}.pem`), 'utf8')))).join('\n'));
  // Two independent cold stores per arm cover Chromium's old and new Linux
  // locations. Only the root is trusted; no cached intermediate is imported.
  for (const name of ['legacy-nss', 'current-nss']) {
    const db = path.join(directory, name); await mkdir(db);
    await run('certutil', ['-N', '-d', `sql:${db}`, '--empty-password']);
    await run('certutil', ['-A', '-d', `sql:${db}`, '-n', 'Render fixture root', '-t', 'C,,', '-i', path.join(directory, 'root.pem')]);
    await chmod(db, 0o777);
    for (const file of ['cert9.db', 'key4.db', 'pkcs11.txt']) await chmod(path.join(db, file), 0o666);
  }
  for (const name of ['trusted', 'untrusted', 'wrong-host', 'incomplete']) await chmod(path.join(directory, `${name}.key`), 0o644);
  return directory;
}
