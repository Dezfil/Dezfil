import { timing } from './render-style-fixture.mjs';

export function gateArms(variant) {
  return (variant === 'both' ? ['style', 'blind'] : [variant]).flatMap(victim =>
    ['public', 'rebind', 'private'].map(mode => {
      const id = `${victim}-${mode}`;
      return { id, mode, variant: victim, author: `${id}.render.test`, phase: 'save' };
    }));
}

export function matrixArms() {
  const arms = [];
  for (const road of ['redirect', 'source', 'sprite', 'glyph', 'tile', 'worker']) for (const mode of ['public', 'rebind']) {
    const id = `${road}-${mode}`, author = `${id}.render.test`, root = `${id}-root.render.test`;
    arms.push({ id, kind: 'dependency', road, mode, author, root, url: `http://${root}:8080/style.json`,
      expected: mode === 'public' ? 'public' : 'denied' });
  }
  for (const [name, address, extra] of [
    ['ipv4', '192.168.99.10:8080', {}],
    ['loopback-alias', 'localhost:3188', { local: true }],
    ['app-other-port', '127.0.0.1:3188', { local: true }],
    ['link-local', '169.254.99.10:8080', { privateSubnet: '169.254.99.0/24', privateIp: '169.254.99.10' }],
    ['ipv6', '[fd00:deaf:beef::10]:8080', { ipv6: true }],
  ]) for (const scheme of ['http', 'https']) for (const redirect of [false, true]) {
    const id = `${name}-${scheme}${redirect ? '-redirect' : ''}`, author = `${id}.render.test`;
    const destination = `${scheme}://${address}/style.json`;
    arms.push({ id, author, kind: 'literal-control', mode: 'public', expected: 'denied', ...extra,
      url: redirect ? `http://${author}:8080/style.json` : destination,
      ...(redirect ? { redirectTo: destination } : {}),
      liveUrl: `http://${address === 'localhost:3188' ? '127.0.0.1:3188' : address}/live` });
  }
  for (const exception of ['hostname', 'ip', 'cidr']) for (const target of ['listed', 'public', 'unlisted']) {
    const id = `allow-${exception}-${target}`, author = `${id}.render.test`;
    const allowlist = exception === 'hostname' ? author : exception === 'ip' ? '192.168.99.10' : '192.168.99.0/24';
    arms.push({ id, author, allowlist, kind: 'allowlist-control', mode: target === 'listed' ? 'private' : 'public',
      expected: target === 'listed' ? 'private-allowed' : target === 'public' ? 'public' : 'denied',
      ...(target === 'unlisted' ? { url: 'http://127.0.0.1:3188/style.json', local: true, liveUrl: 'http://127.0.0.1:3188/live' } : {}) });
  }
  for (const mode of ['dead', 'public-dead']) {
    const id = `dead-${mode}`;
    arms.push({ id, author: `${id}.render.test`, kind: 'dead-control', mode, expected: 'dead' });
  }
  return arms.map(arm => ({ phase: 'save', variant: 'style', ...arm }));
}

export function timingArms() {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `timing-${index < 2 ? 'warmup' : 'sample'}-${index < 2 ? index + 1 : index - 1}`,
    kind: 'timing', mode: 'public', phase: 'save', author: 'timing.render.test', variant: 'style',
    definition: timing.definition, warmup: index < 2, fixture: timing.sha256,
  }));
}
