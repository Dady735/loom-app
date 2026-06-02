import React, { useState, useCallback } from 'react';
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Spinner,
  Badge,
  DataTable,
} from '@shopify/polaris';
import { SearchIcon } from '@shopify/polaris-icons';

const API_URL = process.env.REACT_APP_API_URL || 'https://loom-app.tabishkhan6297.repl.co';

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
};

function StatusBadge({ status }) {
  const tone = STATUS_BADGE_MAP[status];
  if (tone) {
    return <Badge tone={tone}>{status || 'UNKNOWN'}</Badge>;
  }
  return <Badge>{status || 'UNKNOWN'}</Badge>;
}

export default function TrackingLookup() {
  const [trackingNumber, setTrackingNumber] = useState('');
  const [searching, setSearching] = useState(false);
  const [trackResult, setTrackResult] = useState(null);
  const [searchError, setSearchError] = useState(null);

  const handleSearch = useCallback(async () => {
    const tn = trackingNumber.trim();
    if (!tn) return;

    setSearching(true);
    setSearchError(null);
    setTrackResult(null);

    try {
      const response = await fetch(`${API_URL}/api/track/${encodeURIComponent(tn)}`);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      setTrackResult(data);
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  }, [trackingNumber]);

  const handleTrackingChange = useCallback((value) => {
    setTrackingNumber(value);
  }, []);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        handleSearch();
      }
    },
    [handleSearch]
  );

  const historyRows = (trackResult?.history || []).map((entry, i) => {
    const activity = entry.activity || entry.status || '—';
    const updatedAt = entry.updatedAt
      ? new Date(entry.updatedAt).toLocaleString()
      : '—';
    const city = entry.city || entry.location || '—';
    return [i + 1, activity, city, updatedAt];
  });

  return (
    <Page title="Tracking Lookup">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Search PostEx Tracking</Text>
              <Text as="span" tone="subdued">
                Enter a PostEx tracking number to view its current status, the mapped Shopify
                fulfillment status, and the rule that was applied.
              </Text>
              <InlineStack align="start" blockAlign="end" gap="300">
                <div style={{ flex: 1, maxWidth: '480px' }}>
                  <TextField
                    label="Tracking Number"
                    value={trackingNumber}
                    onChange={handleTrackingChange}
                    onKeyDown={handleKeyDown}
                    placeholder="e.g. 27218850025631"
                    autoComplete="off"
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={handleSearch}
                  disabled={searching || !trackingNumber.trim()}
                  icon={SearchIcon}
                >
                  {searching ? 'Searching…' : 'Search'}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {searchError && (
          <Layout.Section>
            <Banner title="Lookup failed" tone="critical">
              {searchError}
            </Banner>
          </Layout.Section>
        )}

        {trackResult && !searching && (
          <>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Tracking Result</Text>
                  <InlineStack gap="300">
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Tracking Number</Text>
                          <Text as="p" variant="headingMd">
                            {trackResult.tracking_number}
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">PostEx Status</Text>
                          <Text as="p" variant="headingMd">
                            <StatusBadge status={trackResult.postex_status} />
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Shopify Status</Text>
                          <Text as="p" variant="headingMd">
                            <StatusBadge status={trackResult.shopify_status} />
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                  </InlineStack>
                  <InlineStack gap="300">
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Rule Applied</Text>
                          <Text as="p" variant="headingMd">
                            {trackResult.rule || '—'}
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    <div style={{ flex: 1 }}>
                      <Card>
                        <BlockStack gap="200">
                          <Text as="span" tone="subdued">Message</Text>
                          <Text as="p" variant="headingMd">
                            {trackResult.message || '—'}
                          </Text>
                        </BlockStack>
                      </Card>
                    </div>
                    {trackResult.priority !== undefined && (
                      <div style={{ flex: 1 }}>
                        <Card>
                          <BlockStack gap="200">
                            <Text as="span" tone="subdued">Priority</Text>
                            <Text as="p" variant="headingMd">
                              {trackResult.priority}
                            </Text>
                          </BlockStack>
                        </Card>
                      </div>
                    )}
                  </InlineStack>
                  {trackResult.error && (
                    <Banner title="Tracking error" tone="warning">
                      {trackResult.error}
                    </Banner>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>

            {historyRows.length > 0 && (
              <Layout.Section>
                <Card>
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingSm">PostEx History Timeline</Text>
                    <DataTable
                      columnContentTypes={[
                        'numeric',
                        'text',
                        'text',
                        'text',
                      ]}
                      headings={['#', 'Activity', 'City / Location', 'Updated At']}
                      rows={historyRows}
                      truncate
                    />
                  </BlockStack>
                </Card>
              </Layout.Section>
            )}

            {historyRows.length === 0 && !trackResult.error && (
              <Layout.Section>
                <Card>
                  <Text as="span" tone="subdued">
                    No history timeline available for this tracking number.
                  </Text>
                </Card>
              </Layout.Section>
            )}
          </>
        )}

        {searching && (
          <Layout.Section>
            <Card>
              <InlineStack align="center" blockAlign="center" gap="300">
                <Spinner accessibilityLabel="Looking up tracking" size="large" />
                <Text as="p" variant="headingLg">Looking up tracking…</Text>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
