import * as React from 'react';
import {
  FormSelect,
  FormSelectOption,
  TextArea,
  Button,
  Alert,
  Label,
  Flex,
  FlexItem,
  Spinner,
} from '@patternfly/react-core';
import { PlayIcon, BoltIcon } from '@patternfly/react-icons';
import { useK8sWatchResource, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import { SecretGVK } from '../../models';
import { chatCompletion, ChatResult } from './aiChatClient';
import { SUBTLE } from '../common/dashboardCards';

type SecretLike = K8sResourceCommon & { data?: Record<string, string> };

/**
 * In-console AI playground — send a real chat completion through the RHCL
 * gateway (auth + TokenRateLimitPolicy) via the `ai-chat` proxy and watch the
 * token usage come back — or a live 429 when the token budget is exhausted.
 * Interactive proof of the same governance the dashboard above measures.
 */
const AiChatPlayground: React.FC = () => {
  const { t } = useTranslation('plugin__kuadrant-console');
  const [secrets] = useK8sWatchResource<SecretLike[]>({
    groupVersionKind: SecretGVK,
    isList: true,
    namespace: 'rhcl-apps',
    selector: { matchLabels: { 'authorino.kuadrant.io/managed-by': 'authorino' } },
  });
  const consumers = React.useMemo(
    () => (secrets || []).map((s) => s.metadata?.name || '').filter(Boolean).sort(),
    [secrets],
  );

  const [consumer, setConsumer] = React.useState('');
  const [prompt, setPrompt] = React.useState('Explique juros compostos em uma frase.');
  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<ChatResult | null>(null);
  const [calls, setCalls] = React.useState(0);
  const [spent, setSpent] = React.useState(0);

  React.useEffect(() => {
    if (!consumer && consumers.length) setConsumer(consumers[0]);
  }, [consumers, consumer]);

  const send = async () => {
    const sec = (secrets || []).find((s) => s.metadata?.name === consumer);
    const key = sec?.data?.api_key ? atob(sec.data.api_key) : '';
    if (!key) {
      setResult({ status: 0, throttled: false, error: t('Could not read the API key for this consumer.') });
      return;
    }
    setSending(true);
    setResult(null);
    const r = await chatCompletion(key, prompt);
    setResult(r);
    setCalls((c) => c + 1);
    if (r.usage?.total_tokens) setSpent((s) => s + (r.usage?.total_tokens || 0));
    setSending(false);
  };

  return (
    <div>
      <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsFlexEnd' }} flexWrap={{ default: 'wrap' }}>
        <FlexItem>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: SUBTLE, marginBottom: 4 }}>
            {t('Consumer (API key)')}
          </div>
          <FormSelect
            value={consumer}
            onChange={(_e, v) => setConsumer(v)}
            aria-label={t('Consumer')}
            style={{ minWidth: 260 }}
          >
            {consumers.length === 0 && <FormSelectOption value="" label={t('No API keys found')} />}
            {consumers.map((c) => (
              <FormSelectOption key={c} value={c} label={c} />
            ))}
          </FormSelect>
        </FlexItem>
        <FlexItem flex={{ default: 'flex_1' }} style={{ minWidth: 280 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: SUBTLE, marginBottom: 4 }}>
            {t('Prompt')}
          </div>
          <TextArea
            value={prompt}
            onChange={(_e, v) => setPrompt(v)}
            aria-label={t('Prompt')}
            rows={2}
            resizeOrientation="vertical"
          />
        </FlexItem>
        <FlexItem>
          <Button variant="primary" icon={<PlayIcon />} onClick={send} isLoading={sending} isDisabled={sending || !consumer}>
            {t('Send')}
          </Button>
        </FlexItem>
      </Flex>

      <Flex spaceItems={{ default: 'spaceItemsSm' }} style={{ marginTop: 10 }}>
        <FlexItem>
          <Label isCompact icon={<BoltIcon />}>{t('{{n}} calls', { n: calls })}</Label>
        </FlexItem>
        <FlexItem>
          <Label isCompact color="blue">{t('{{n}} tokens spent this session', { n: spent })}</Label>
        </FlexItem>
        <FlexItem>
          <span style={{ fontSize: 11, color: SUBTLE }}>{t('Real call through the gateway — counts against the token budget.')}</span>
        </FlexItem>
      </Flex>

      {sending && (
        <Flex alignItems={{ default: 'alignItemsCenter' }} spaceItems={{ default: 'spaceItemsSm' }} style={{ marginTop: 12 }}>
          <FlexItem><Spinner size="md" /></FlexItem>
          <FlexItem>{t('Calling /api/v1/chat/completions…')}</FlexItem>
        </Flex>
      )}

      {result && !sending && (
        <div style={{ marginTop: 14 }}>
          {result.throttled ? (
            <Alert variant="danger" isInline title={t('429 — token budget exceeded')}>
              {t('The TokenRateLimitPolicy rejected this call: the shared per-minute token budget is used up. Wait for the window to reset (~60s) and try again.')}
            </Alert>
          ) : result.error ? (
            <Alert variant="warning" isInline title={t('Call failed')}>
              {result.error}
            </Alert>
          ) : (
            <>
              <Flex spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
                <FlexItem><Label isCompact color="green">HTTP {result.status}</Label></FlexItem>
                {result.cloud && <FlexItem><Label isCompact color="purple">{result.cloud}</Label></FlexItem>}
                {result.usage && (
                  <>
                    <FlexItem><Label isCompact>{t('prompt {{n}}', { n: result.usage.prompt_tokens ?? 0 })}</Label></FlexItem>
                    <FlexItem><Label isCompact>{t('completion {{n}}', { n: result.usage.completion_tokens ?? 0 })}</Label></FlexItem>
                    <FlexItem><Label isCompact color="blue" icon={<BoltIcon />}>{t('total {{n}} tok', { n: result.usage.total_tokens ?? 0 })}</Label></FlexItem>
                  </>
                )}
              </Flex>
              {result.content && (
                <div style={{ marginTop: 10, padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--pf-t--global--text--color--regular)', fontSize: 14, lineHeight: 1.5 }}>
                  {result.content}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {!result && !sending && (
        <div style={{ marginTop: 12, fontSize: 12, color: SUBTLE }}>
          {t('Pick a consumer, edit the prompt and press Send. Fire it repeatedly to burn the token budget and watch the 429 kick in.')}
        </div>
      )}
    </div>
  );
};

export default AiChatPlayground;
