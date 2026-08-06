import * as React from 'react';
import { SetFeatureFlag } from '@openshift-console/dynamic-plugin-sdk';
import { usePluginConfig } from '../utils/pluginConfig';

/**
 * Feature flag set whenever the runtime ConfigMap declares an
 * `internalDeveloperHubUrl`. Drives the conditional "Internal Developer
 * Hub" sidebar item (req029) — when the URL is missing, the flag stays
 * false and the console hides the nav entry entirely.
 *
 * Mirrors developerPortalFlag exactly: registered as a
 * `console.flag/hookProvider` so the SDK invokes it as a React hook and
 * we can re-emit when the URL is added, removed, or edited at runtime —
 * no Console reload required. Keeping the two links as independent flags
 * (rather than one shared "external links present" flag) lets a customer
 * enable either the external Developer Portal, the Internal Developer
 * Hub, both, or neither.
 */
export const INTERNAL_DEVELOPER_HUB_FLAG = 'INTERNAL_DEVELOPER_HUB_URL_PRESENT';

export const useInternalDeveloperHubFlag = (setFlag: SetFeatureFlag): void => {
  const { config, loaded } = usePluginConfig();

  // Until the ConfigMap watch has at least returned once, leave the flag
  // unset rather than flapping false→true on first paint — the nav item
  // is also gated on the flag being explicitly true.
  const hasUrl = loaded && !!config.internalDeveloperHubUrl?.trim();

  React.useEffect(() => {
    setFlag(INTERNAL_DEVELOPER_HUB_FLAG, hasUrl);
  }, [setFlag, hasUrl]);
};
