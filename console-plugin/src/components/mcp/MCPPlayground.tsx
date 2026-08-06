import * as React from 'react';
import {
  Button,
  Spinner,
  Alert,
  TextArea,
  Flex,
  FlexItem,
  ClipboardCopy,
  ClipboardCopyVariant,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { mcpCallTool, McpTool } from './mcpBrokerClient';
import { McpCatalogStatus } from './useMcpBrokerCatalog';

/**
 * In-console "try it" invoker — the interactive half of the MCP server
 * dashboard. The broker connection + tool list are owned by the dashboard's
 * `useMcpBrokerCatalog` hook (one session for the whole page); this component
 * just edits arguments for the currently-selected tool and calls it live
 * (`tools/call` over the console proxy) — `mcpBrokerClient` handles the wire.
 */
const MCPPlayground: React.FC<{
  session: string | null;
  tool: McpTool | null;
  status: McpCatalogStatus;
  error: string | null;
  onRetry: () => void;
}> = ({ session, tool, status, error, onRetry }) => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const [argsText, setArgsText] = React.useState('{}');
  const [calling, setCalling] = React.useState(false);
  const [callResult, setCallResult] = React.useState<string | null>(null);

  // Reset the editor + result whenever a different tool is selected.
  React.useEffect(() => {
    setArgsText('{}');
    setCallResult(null);
  }, [tool?.name]);

  const call = async () => {
    if (!session || !tool) return;
    setCalling(true);
    setCallResult(null);
    try {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsText || '{}');
      } catch {
        throw new Error(t('Arguments must be valid JSON.'));
      }
      const r = await mcpCallTool(session, tool.name, args);
      setCallResult(JSON.stringify(r, null, 2));
    } catch (e) {
      setCallResult(`${t('Error')}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCalling(false);
    }
  };

  if (status === 'connecting') {
    return (
      <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }}>
        <FlexItem>
          <Spinner size="md" />
        </FlexItem>
        <FlexItem>{t('Connecting to the MCP broker…')}</FlexItem>
      </Flex>
    );
  }

  if (status === 'error') {
    return (
      <Alert variant="warning" isInline title={t('Could not reach the MCP broker')}>
        <p>{error}</p>
        <p style={{ marginTop: 8, fontSize: 12 }}>
          {t(
            'The playground calls the broker through the console’s "mcp-broker" proxy. Ensure the MCP Gateway is installed and the ConsolePlugin proxy alias points at a TLS-fronted broker Service (see tests/req073).',
          )}
        </p>
        <Button variant="link" isInline onClick={onRetry} style={{ marginTop: 8 }}>
          {t('Retry')}
        </Button>
      </Alert>
    );
  }

  if (!tool) {
    return (
      <p style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>
        {t('Pick a tool from the catalog above and press “Try” to call it live.')}
      </p>
    );
  }

  return (
    <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsMd' }}>
      <FlexItem>
        <div style={{ fontSize: 13, fontWeight: 700 }}>
          <code>{tool.name}</code>
        </div>
        {tool.description && (
          <div style={{ color: 'var(--pf-t--global--text--color--subtle)', marginTop: 2 }}>
            {tool.description}
          </div>
        )}
      </FlexItem>
      <FlexItem>
        <div
          style={{
            fontSize: 12,
            textTransform: 'uppercase',
            letterSpacing: '.05em',
            color: 'var(--pf-t--global--text--color--subtle)',
            marginBottom: 6,
          }}
        >
          {t('Arguments (JSON)')}
        </div>
        <TextArea
          aria-label={t('Arguments (JSON)')}
          value={argsText}
          onChange={(_e, v) => setArgsText(v)}
          rows={4}
          style={{ fontFamily: 'monospace', fontSize: 13 }}
        />
      </FlexItem>
      <FlexItem>
        <Button variant="primary" onClick={call} isLoading={calling} isDisabled={calling}>
          {t('Call {{tool}}', { tool: tool.name })}
        </Button>
      </FlexItem>
      {callResult !== null && (
        <FlexItem>
          <div
            style={{
              fontSize: 12,
              textTransform: 'uppercase',
              letterSpacing: '.05em',
              color: 'var(--pf-t--global--text--color--subtle)',
              marginBottom: 6,
            }}
          >
            {t('Result')}
          </div>
          <ClipboardCopy
            isCode
            isReadOnly
            variant={ClipboardCopyVariant.expansion}
            hoverTip={t('Copy')}
            clickTip={t('Copied')}
          >
            {callResult}
          </ClipboardCopy>
        </FlexItem>
      )}
    </Flex>
  );
};

export default MCPPlayground;
