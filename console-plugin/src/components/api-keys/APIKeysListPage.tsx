import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  PageSection,
  Title,
  Card,
  CardBody,
  Spinner,
  Bullseye,
  EmptyState,
  EmptyStateBody,
  Label,
  Button,
  Tooltip,
  Flex,
  FlexItem,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  SearchInput,
  Select,
  SelectList,
  SelectOption,
  MenuToggle,
  type MenuToggleElement,
} from '@patternfly/react-core';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import {
  useK8sWatchResource,
  useAccessReview,
  consoleFetch,
  consoleFetchJSON,
} from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import { PlusCircleIcon } from '@patternfly/react-icons';
import { APIKeyGVK } from '../../models';
import { APIKey, getAPIKeyPhase } from '../../types';
import ResourceActionsMenu from '../common/ResourceActionsMenu';
import CreateAPIKeyModal, { AUTHORINO_MANAGED_BY_LABEL } from './CreateAPIKeyModal';
import '../../styles/plugin-glass.css';

/**
 * Cluster-wide API Keys list. Mirrors what the APIKeysTable on the
 * APIProduct overview does, but unscoped: surfaces *every* APIKey across
 * every API product, with filters for phase / API / requester so an
 * operator can drive approvals from a single screen.
 *
 * Approve/reject creates an APIKeyApproval CR pointing at the request the
 * controller auto-spawned for each APIKey — same workflow as the
 * APIKeysTable, factored so the action logic isn't duplicated.
 */
const PHASE_COLORS: Record<string, 'blue' | 'green' | 'red' | 'grey'> = {
  Pending: 'blue',
  Approved: 'green',
  Rejected: 'red',
};

type PhaseFilter = 'all' | 'Pending' | 'Approved' | 'Rejected';

const APIKeysListPage: React.FC = () => {
  const { t } = useTranslation('plugin__kuadrant-console');

  // Cluster-wide: no `namespace` field on the watch. The plugin uses
  // namespace="" by default to mean "all namespaces" when isList=true.
  const [keys, keysLoaded] = useK8sWatchResource<APIKey[]>({
    groupVersionKind: APIKeyGVK,
    isList: true,
  });
  // Track keys that have an Approve/Reject request in flight. Used to
  // disable the row's action buttons and switch them to a spinner so the
  // operator gets immediate visual feedback — the watch can take a
  // second to reflect the new status, and a non-responsive button is
  // indistinguishable from a broken one.
  const [pendingActions, setPendingActions] = React.useState<Record<string, true>>({});
  const isActionPending = (key: APIKey): boolean =>
    !!pendingActions[`${key.metadata?.namespace || ''}/${key.metadata?.name || ''}`];
  // Approval = create Secret + patch APIKey status. Both verbs need access.
  // We check the broader of the two (Secret create) since that's the one a
  // viewer typically lacks.
  const [canApprove] = useAccessReview({
    resource: 'secrets',
    verb: 'create',
  });

  const [reviewer, setReviewer] = React.useState<string>('console');
  React.useEffect(() => {
    consoleFetchJSON('/apis/user.openshift.io/v1/users/~')
      .then((u: { metadata?: { name?: string } }) => {
        if (u?.metadata?.name) setReviewer(u.metadata.name);
      })
      .catch(() => undefined);
  }, []);

  const [search, setSearch] = React.useState('');
  const [phase, setPhase] = React.useState<PhaseFilter>('all');
  const [phaseOpen, setPhaseOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return (keys || []).filter((k) => {
      if (phase !== 'all' && getAPIKeyPhase(k) !== phase) return false;
      if (!q) return true;
      const hay = [
        k.metadata?.name,
        k.metadata?.namespace,
        k.spec.apiProductRef?.name,
        k.spec.planTier,
        k.spec.requestedBy?.email,
        k.spec.requestedBy?.userId,
        k.spec.useCase,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [keys, phase, search]);

  const counts = React.useMemo(
    () => ({
      total: keys?.length || 0,
      pending: (keys || []).filter((k) => getAPIKeyPhase(k) === 'Pending').length,
      approved: (keys || []).filter((k) => getAPIKeyPhase(k) === 'Approved').length,
      rejected: (keys || []).filter((k) => getAPIKeyPhase(k) === 'Rejected').length,
    }),
    [keys],
  );

  // ---------- Approval workflow (Kuadrant 1.3 — direct CR mutation) -----
  //
  // Creating an APIKeyApproval CR does nothing — the kuadrant-operator does not
  // reconcile it (verified on cluster: an approved=true approval left the key
  // Pending and inactive for good). What actually gates a key is the
  // `authorino.kuadrant.io/managed-by` label on its Secret: present → Authorino
  // accepts the key (<2s), absent → 401. The Create API Key modal creates the
  // Secret WITHOUT that label (inactive), so we drive activation here:
  //
  //   1. Approve  → add the managed-by label to the key's secretRef Secret,
  //                 then PATCH the APIKey status so the UI reflects the phase.
  //   2. Reject   → remove the label (deactivate) + PATCH the status.
  //
  // The status patch goes through consoleFetch because the SDK helper for
  // status subresource patching has been flaky across SDK versions; raw
  // fetch with `Content-Type: application/merge-patch+json` is portable.

  function generateApiKey(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = 'bk_live_';
    bytes.forEach((b) => { out += alpha[b % alpha.length]; });
    return out;
  }

  const isNotFound = (e: unknown): boolean => {
    const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const code = (e as { code?: unknown }).code;
    return code === 404 || msg.includes('404') || msg.includes('not found');
  };

  // Approve = add the managed-by label to the key's Secret (activation gate).
  // The modal already created that Secret inactive with the key value, so we
  // only flip the label — no new key is minted. Idempotent: re-adding a label
  // that is already there is a no-op patch.
  async function activateApiKeySecret(key: APIKey) {
    const ns = key.metadata?.namespace || '';
    const secretName = key.spec.secretRef?.name;
    if (!secretName) {
      throw new Error(
        `APIKey ${key.metadata?.name} has no spec.secretRef — nothing to activate.`,
      );
    }
    try {
      await consoleFetch(
        `/api/kubernetes/api/v1/namespaces/${ns}/secrets/${secretName}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({
            metadata: { labels: { [AUTHORINO_MANAGED_BY_LABEL]: 'authorino' } },
          }),
        },
      );
      return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    // Fallback: the Secret is gone (APIKey created out-of-band). Recreate it
    // active with a fresh key so approve never hard-fails. The `app` label is
    // derived from the product name (not hardcoded) so this works for any API.
    const userId = key.spec.requestedBy?.userId || 'unknown';
    const body = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: ns,
        labels: {
          app: `${key.spec.apiProductRef?.name || 'api'}-apikey`,
          [AUTHORINO_MANAGED_BY_LABEL]: 'authorino',
          'app.kubernetes.io/managed-by': 'kuadrant-console',
        },
        annotations: {
          'secret.kuadrant.io/plan-id': key.spec.planTier || 'bronze',
          'secret.kuadrant.io/user-id': userId,
          'devportal.kuadrant.io/source': 'kuadrant-console',
        },
      },
      type: 'Opaque',
      stringData: { api_key: generateApiKey() },
    };
    try {
      await consoleFetch(
        `/api/kubernetes/api/v1/namespaces/${ns}/secrets`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      const code = (e as { code?: unknown }).code;
      if (code === 409 || msg.includes('409') || msg.includes('already exists')) {
        return; // raced with another approver — the Secret exists, good enough
      }
      throw e;
    }
  }

  // Reject = strip the managed-by label so Authorino stops accepting the key
  // (merge-patch with null deletes the label). No-op if it was never active.
  async function deactivateApiKeySecret(key: APIKey) {
    const ns = key.metadata?.namespace || '';
    const secretName = key.spec.secretRef?.name;
    if (!secretName) return;
    try {
      await consoleFetch(
        `/api/kubernetes/api/v1/namespaces/${ns}/secrets/${secretName}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/merge-patch+json' },
          body: JSON.stringify({
            metadata: { labels: { [AUTHORINO_MANAGED_BY_LABEL]: null } },
          }),
        },
      );
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async function patchAPIKeyStatus(key: APIKey, action: 'Approved' | 'Rejected') {
    const ns = key.metadata?.namespace || '';
    const name = key.metadata?.name || '';
    const now = new Date().toISOString();
    // `getAPIKeyPhase` reads `type === 'Approved' | 'Rejected'` with
    // `status === 'True'` — so we have to write the condition with the
    // *action* as the type, not 'Ready'. The previous shape (`type: 'Ready'`
    // + `reason: 'Approved'`) was silently ignored and the row stayed
    // Pending in the UI even though the cluster had accepted the patch.
    const status = {
      phase: action,
      conditions: [
        {
          type: action,
          status: 'True',
          reason: action,
          message:
            action === 'Approved'
              ? `Approved by ${reviewer} via kuadrant-console`
              : `Rejected by ${reviewer} via kuadrant-console`,
          lastTransitionTime: now,
        },
      ],
    };
    await consoleFetch(
      `/api/kubernetes/apis/${APIKeyGVK.group}/${APIKeyGVK.version}/namespaces/${ns}/apikeys/${name}/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json' },
        body: JSON.stringify({ status }),
      },
    );
  }

  const handleAction = async (key: APIKey, action: 'Approved' | 'Rejected') => {
    const keyId = `${key.metadata?.namespace || ''}/${key.metadata?.name || ''}`;
    setPendingActions((prev) => ({ ...prev, [keyId]: true }));
    try {
      if (action === 'Approved') {
        await activateApiKeySecret(key);
      } else {
        await deactivateApiKeySecret(key);
      }
      await patchAPIKeyStatus(key, action);
    } catch (e) {
      // Make failure visible — the row stays Pending and the console gets
      // the error. A toast layer would be nicer; keeping the surface area
      // minimal until we have a shared notification primitive.
      console.error(`Failed to ${action.toLowerCase()} ${key.metadata?.name}:`, e);
      alert(`Failed to ${action.toLowerCase()}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // Clear the spinner. The k8sWatch will re-render with the new phase
      // (Approved/Rejected) shortly after and the row's buttons disappear
      // because `isPending` flips false.
      setPendingActions((prev) => {
        const next = { ...prev };
        delete next[keyId];
        return next;
      });
    }
  };

  if (!keysLoaded) {
    return (
      <Bullseye style={{ minHeight: 200 }}>
        <Spinner size="lg" />
      </Bullseye>
    );
  }

  return (
    <div className="rhcl-plugin-root">
      <PageSection variant="default">
        <Flex alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem grow={{ default: 'grow' }}>
            <Title headingLevel="h1">{t('API Keys')}</Title>
            <p style={{ marginTop: 4, color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}>
              {t(
                'Approve, reject and audit API key requests across every API product on the cluster.',
              )}
            </p>
          </FlexItem>
          <FlexItem>
            <Button
              variant="primary"
              icon={<PlusCircleIcon />}
              onClick={() => setCreateOpen(true)}
            >
              {t('Create API Key')}
            </Button>
          </FlexItem>
        </Flex>
        <Flex spaceItems={{ default: 'spaceItemsMd' }} style={{ marginTop: 12 }}>
          <FlexItem>
            <Label color="grey" isCompact>
              {counts.total} {t('total')}
            </Label>
          </FlexItem>
          <FlexItem>
            <Label color="blue" isCompact>
              {counts.pending} {t('pending')}
            </Label>
          </FlexItem>
          <FlexItem>
            <Label color="green" isCompact>
              {counts.approved} {t('approved')}
            </Label>
          </FlexItem>
          <FlexItem>
            <Label color="red" isCompact>
              {counts.rejected} {t('rejected')}
            </Label>
          </FlexItem>
        </Flex>
      </PageSection>

      <PageSection>
        <Card>
          <CardBody>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <SearchInput
                    aria-label={t('Filter')}
                    placeholder={t('Filter by name, API, requester…')}
                    value={search}
                    onChange={(_e, v) => setSearch(v)}
                    onClear={() => setSearch('')}
                  />
                </ToolbarItem>
                <ToolbarItem>
                  <Select
                    isOpen={phaseOpen}
                    selected={phase}
                    onSelect={(_e, v) => {
                      setPhase((v as PhaseFilter) || 'all');
                      setPhaseOpen(false);
                    }}
                    onOpenChange={(o) => setPhaseOpen(o)}
                    toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                      <MenuToggle ref={toggleRef} onClick={() => setPhaseOpen((o) => !o)}>
                        {t('Phase')}: {phase === 'all' ? t('all') : t(phase)}
                      </MenuToggle>
                    )}
                  >
                    <SelectList>
                      <SelectOption value="all">{t('All')}</SelectOption>
                      <SelectOption value="Pending">{t('Pending')}</SelectOption>
                      <SelectOption value="Approved">{t('Approved')}</SelectOption>
                      <SelectOption value="Rejected">{t('Rejected')}</SelectOption>
                    </SelectList>
                  </Select>
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>

            {filtered.length === 0 ? (
              <EmptyState variant="sm" titleText={t('No API keys match')} headingLevel="h4">
                <EmptyStateBody>
                  {keys?.length === 0
                    ? t('No API key requests have been submitted yet.')
                    : t('Adjust the filters above to see other requests.')}
                </EmptyStateBody>
              </EmptyState>
            ) : (
              <Table aria-label={t('API Keys')} variant="compact">
                <Thead>
                  <Tr>
                    <Th>{t('Name')}</Th>
                    <Th>{t('API')}</Th>
                    <Th>{t('Plan')}</Th>
                    <Th>{t('Requester')}</Th>
                    <Th>{t('Phase')}</Th>
                    <Th>{t('Created')}</Th>
                    <Th>{t('Actions')}</Th>
                    <Th aria-label={t('Actions')} />
                  </Tr>
                </Thead>
                <Tbody>
                  {filtered.map((key) => {
                    const ph = getAPIKeyPhase(key);
                    const isPending = ph === 'Pending';
                    const ns = key.metadata?.namespace || '';
                    const apiName = key.spec.apiProductRef?.name || '-';
                    return (
                      <Tr key={key.metadata?.uid}>
                        <Td>
                          {key.metadata?.name}
                          <div style={{ fontSize: 11, color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}>
                            {ns}
                          </div>
                        </Td>
                        <Td>
                          <Link to={`/connectivity-link/api-products/${ns}/${apiName}`}>
                            {apiName}
                          </Link>
                        </Td>
                        <Td>{key.spec.planTier || '-'}</Td>
                        <Td>
                          {key.spec.requestedBy?.email || '-'}
                          {key.spec.requestedBy?.userId && key.spec.requestedBy.userId !== key.spec.requestedBy.email && (
                            <div style={{ fontSize: 11, color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}>
                              {key.spec.requestedBy.userId}
                            </div>
                          )}
                        </Td>
                        <Td>
                          <Label color={PHASE_COLORS[ph] || 'grey'}>{t(ph)}</Label>
                        </Td>
                        <Td>
                          {key.metadata?.creationTimestamp
                            ? new Date(key.metadata.creationTimestamp).toLocaleString()
                            : '-'}
                        </Td>
                        <Td>
                          {isPending && (
                            <Flex spaceItems={{ default: 'spaceItemsSm' }}>
                              <FlexItem>
                                <ActionButton
                                  kind="primary"
                                  disabled={!canApprove}
                                  isLoading={isActionPending(key)}
                                  tooltipWhenDisabled={t('You do not have permission to approve API keys')}
                                  onClick={() => handleAction(key, 'Approved')}
                                  label={t('Approve')}
                                />
                              </FlexItem>
                              <FlexItem>
                                <ActionButton
                                  kind="danger"
                                  disabled={!canApprove}
                                  isLoading={isActionPending(key)}
                                  tooltipWhenDisabled={t('You do not have permission to reject API keys')}
                                  onClick={() => handleAction(key, 'Rejected')}
                                  label={t('Reject')}
                                />
                              </FlexItem>
                            </Flex>
                          )}
                        </Td>
                        <Td isActionCell>
                          <ResourceActionsMenu
                            gvk={APIKeyGVK}
                            namespace={ns}
                            name={key.metadata?.name || ''}
                            listHref="/connectivity-link/api-keys"
                          />
                        </Td>
                      </Tr>
                    );
                  })}
                </Tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </PageSection>

      {/* Create-modal at page scope so it survives the CardBody
          collapsing when the empty state re-renders. The k8s watch
          picks up the freshly-created APIKey CR automatically. */}
      <CreateAPIKeyModal isOpen={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
};

const ActionButton: React.FC<{
  kind: 'primary' | 'danger';
  disabled: boolean;
  tooltipWhenDisabled: string;
  label: string;
  onClick: () => void;
  isLoading?: boolean;
}> = ({ kind, disabled, tooltipWhenDisabled, label, onClick, isLoading }) => {
  const btn = (
    <Button
      variant={kind}
      size="sm"
      isDisabled={disabled || isLoading}
      isLoading={isLoading}
      onClick={disabled || isLoading ? undefined : onClick}
    >
      {label}
    </Button>
  );
  return disabled ? <Tooltip content={tooltipWhenDisabled}>{btn}</Tooltip> : btn;
};

export default APIKeysListPage;
