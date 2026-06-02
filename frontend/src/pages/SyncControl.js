import React, { useState, useCallback } from 'react';
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Spinner,
  Checkbox,
  DataTable,
  Badge,
} from '@shopify/polaris';

const API_URL = process.env.REACT_APP_API_URL || '';

const STATUS_BADGE_MAP = {
  DELIVERED: 'success',
  IN_TRANSIT: 'info',
  OUT_FOR_DELIVERY: 'info',
  ATTEMPTED_DELIVERY: 'warning',
  FAILURE: 'critical',
  DELAYED: 'warning',
  CONFIRMED: 'info',
  LABEL_PRINTED: undefined,
  LABEL_PURCHASED: undefined,
  ERROR: 'critical',
  running: 'attention',
  completed: 'success',
  failed: 'critical',
  pending: undefined,
};

function StatusBadge({ status }) {
  const tone = STATUS_BADGE_MAP[status];
  if (tone) {
    return <Badge tone={tone}>{status || 'UNKNOWN'}</Badge>;
  }
  return <Badge>{status || 'UNKNOWN'}</Badge>;
}

export default function SyncControl() {
  const [dryRun, setDryRun] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncError, setSyncError] = useState(null);

  const triggerSync = useCallback(
    async (quick) => {
      setSyncing(true);
      setSyncError(null);
      setSyncResult(null);

      const payload = { quick, dry_run: dryRun };

      try {
        const response = await fetch(`${API_URL}/api/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        setSyncResult(data);
      } catch (err) {
        setSyncError(err.message);
      } finally {
        setSyncing(false);
      }
    },
    [dryRun]
  );

  const handleQuickSync = useCallback(() => {
    triggerSync(true);
  }, [triggerSync]);

  const handleFullSync = useCallback(() => {
    triggerSync(false);
  }, [triggerSync]);

  const handleDryRunChange = useCallback(
    (newValue) => setDryRun(newValue),
    []
  );

  const resultRows = (syncResult?.results || []).map((r, i) => [
    r.order_number || '—',
    r.tracking_number || '—',
    <StatusBadge key={`postex-${i}`} status={r.postex_status} />,
    <StatusBadge key={`shopify-${i}`} status={r.shopify_status} />,
    r.rule || '—',
    r.message || '—',
  ]);

  return (
    <Page title="Sync Control">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Trigger a Sync</Text>
              <Text as="span" tone="subdued">
                Sync PostEx tracking statuses with Shopify fulfillment events.
                Quick sync processes the last 30 days; full sync goes back up to 12 months.
              </Text>

              <Checkbox
                label="Dry Run (no Shopify updates)"
                checked={dryRun}
                onChange={handleDryRunChange}
                helpText="When enabled, the sync will run but no changes will be written to Shopify."
              />

              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={handleQuickSync}
                  disabled={syncing}
                >
                  {syncing ? 'Syncing…' : 'Quick Sync'}
                </Button>
                <Button
                  onClick={handleFullSync}
                  disabled={syncing}
                >
                  {syncing ? 'Syncing…' : 'Full Sync'}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {syncing && (
          <Layout.Section>
            <Card>
              <InlineStack align="center" blockAlign="center" gap="300">
                <Spinner accessibilityLabel="Syncing orders" size="large" />
                <Text as="p" variant="headingLg">Sync in progress…</Text>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {syncError && (
          <Layout.Section>
            <Banner title="Sync failed" tone="critical">
              {syncError}
            </Banner>
          </Layout.Section>
        )}

        {syncResult && !syncing && (
          <>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Last Sync Result</Text>
                  <InlineStack gap="300">
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Status</Text>
                          <Text as="p" variant="headingLg">
                            <StatusBadge status={syncResult.status} />
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Processed</Text>
                          <Text as="p" variant="headingLg">
                            {syncResult.orders_processed ?? 0}
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Updated</Text>
                          <Text as="p" variant="headingLg">
                            {syncResult.orders_updated ?? 0}
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Failed</Text>
                          <Text as="p" variant="headingLg">
                            <Text as="span" tone="critical">
                              {syncResult.orders_failed ?? 0}
                            </Text>
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                  </InlineStack>
                  {syncResult.dry_run && (
                    <Banner title="Dry Run Mode" tone="info">
                      This was a dry run — no changes were written to Shopify.
                    </Banner>
                  )}
                  {syncResult.log_id && (
                    <Text as="span" tone="subdued">
                      Log ID: {syncResult.log_id}
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>

            {resultRows.length > 0 && (
              <Layout.Section>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm">Sync Results (up to 50)</Text>
                    <DataTable
                      columnContentTypes={[
                        'text',
                        'text',
                        'text',
                        'text',
                        'text',
                        'text',
                      ]}
                      headings={[
                        'Order #',
                        'Tracking #',
                        'PostEx Status',
                        'Shopify Status',
                        'Rule',
                        'Message',
                      ]}
                      rows={resultRows}
                      truncate
                    />
                  </BlockStack>
                </Card>
              </Layout.Section>
            )}
          </>
        )}
      </Layout>
    </Page>
  );
}
