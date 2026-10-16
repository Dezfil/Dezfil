"use client";
import Link from 'next/link';
import { useId, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { MCP_CLIENTS, clientGuide, type McpClientName } from '@/lib/mcp/client-guide';
import { checkMcpConnection } from '@/lib/mcp/connection';
import { CardActions, LabelledField, Note, SettingsCard } from './SettingsCard';
import cardStyles from './SettingsCard.module.css';
import styles from './McpCard.module.css';

const subscribe = () => () => {};
const visibleEndpoint = () => new URL('/api/mcp', window.location.origin).href;
const serverEndpoint = () => '';

/** The MCP server card, under the person's tokens: this instance's
 * endpoint, the client choice with each client's configuration and Copy,
 * and the read-only connection check with the browser's own session. The
 * same endpoint supplies the configuration and the check. */
export function McpCard() {
  const ids = useId();
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
  return <SettingsCard id="mcp" title="MCP server" headingId="mcp-heading">
    <Note>Create a token in the card above. Set <code>DEZFIL_API_TOKEN</code> to it in the environment that starts your client.</Note>
    <code className={styles.endpoint}>{endpoint || '/api/mcp'}</code>
    <LabelledField id="set-mcp-client" label="MCP client" inputId={`${ids}-client`}>
      <Select id={`${ids}-client`} value={client} onChange={event => { setClient(event.target.value as McpClientName); setCopy(''); }}>
        {MCP_CLIENTS.map(name => <option key={name}>{name}</option>)}
      </Select>
    </LabelledField>
    <Note>{guide.setup} <a href={guide.source} className={cardStyles.link}>Client documentation</a></Note>
    {guide.limitation && <Note>{guide.limitation}</Note>}
    {guide.supported && <>
      <pre className={styles.configuration} aria-label={`${client} configuration`}><code>{endpoint ? guide.code : '/api/mcp'}</code></pre>
      <CardActions>
        <Button onClick={copyConfiguration} disabled={!endpoint}>Copy</Button>
        <span role="status" className={styles.status}>{copy}</span>
      </CardActions>
    </>}
    {guide.alternate && <pre className={styles.configuration} aria-label="Codex config.toml"><code>{guide.alternate}</code></pre>}
    <div id="mcp-check" className={cardStyles.actions}>
      <Button onClick={connect} busy={check.pending} disabled={!endpoint}>Check connection</Button>
      <span role="status" className={styles.status} data-failed={check.failed || undefined}>{check.message}</span>
    </div>
    <Note>This checks your browser session. Other clients use their own API token.</Note>
    <Note>
      <Link href="/developer" className={cardStyles.link}>API reference</Link>
      {' · '}
      <a href="/api/openapi.json" className={cardStyles.link}>API contract and edit revisions</a>
    </Note>
  </SettingsCard>;
}
