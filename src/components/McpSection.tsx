"use client";
import { useSyncExternalStore, useState } from 'react';
import { Button } from './ui/Button';
import { Select } from './ui/Field';
import { MCP_CLIENTS, clientGuide, type McpClientName } from '@/lib/mcp/client-guide';
import { checkMcpConnection } from '@/lib/mcp/connection';
import styles from './McpSection.module.css';

const subscribe = () => () => {};
const visibleEndpoint = () => new URL('/api/mcp', window.location.origin).href;
const serverEndpoint = () => '';

/** The same endpoint supplies configuration and the read-only MCP check. */
export function McpSection() {
  const endpoint = useSyncExternalStore(subscribe, visibleEndpoint, serverEndpoint);
  const [client, setClient] = useState<McpClientName>('Claude Code');
  const [copy, setCopy] = useState('');
  const [check, setCheck] = useState<{ pending: boolean; message: string; failed?: boolean }>({ pending: false, message: '' });
  const guide = clientGuide(client, endpoint);
  async function copyConfiguration() {
    try { await navigator.clipboard.writeText(guide.code); setCopy('Copied'); }
    catch { setCopy('Copy is unavailable in this browser. Select the configuration to copy it.'); }
  }
  async function connect() {
    setCheck({ pending: true, message: 'Checking connection…' });
    try {
      const count = await checkMcpConnection(endpoint);
      setCheck({ pending: false, message: `Connected. ${count} tools available.` });
    } catch (error) { setCheck({ pending: false, failed: true, message: (error as Error).message }); }
  }
  return (
    <section className={styles.card} aria-labelledby="mcp-guide-title">
      <div className={styles.head}><h2 id="mcp-guide-title">MCP server</h2></div>
      <p>Create an <a href="/settings#tokens-heading">API / MCP token in Settings</a>. Set <code>DEZFIL_API_TOKEN</code> in the environment that starts your client.</p>
      <code className={styles.endpoint}>{endpoint || '/api/mcp'}</code>
      <label className={styles.client}>MCP client
        <Select value={client} onChange={event => { setClient(event.target.value as McpClientName); setCopy(''); }}>
          {MCP_CLIENTS.map(name => <option key={name}>{name}</option>)}
        </Select>
      </label>
      <p>{guide.setup} <a href={guide.source}>Client documentation</a></p>
      {guide.limitation && <p>{guide.limitation}</p>}
      {guide.supported && <><pre className={styles.configuration} aria-label={`${client} configuration`}><code>{endpoint ? guide.code : '/api/mcp'}</code></pre>
      <div className={styles.actions}>
        <Button onClick={copyConfiguration} disabled={!endpoint}>Copy</Button>
        <span role="status" className={styles.status}>{copy}</span>
      </div>
      </>}
      {guide.alternate && <pre className={styles.configuration} aria-label="Codex config.toml"><code>{guide.alternate}</code></pre>}
      <div className={styles.actions}>
        <Button onClick={connect} busy={check.pending} disabled={!endpoint}>Check connection</Button>
        <span role="status" className={styles.status} data-failed={check.failed || undefined}>{check.message}</span>
      </div>
      <p>This checks your browser session. Other clients use their own API token.</p>
      <p><a href="/api/openapi.json">Documented limits and history contract</a></p>
    </section>
  );
}
