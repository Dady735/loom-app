import React, { useState, useEffect, useCallback } from 'react';
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  DataTable,
  Spinner,
  Banner,
  SkeletonDisplayText,
  SkeletonBodyText,
} from '@shopify/polaris';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';

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

export default function Dashboard() {
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/dashboard`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      setDashboardData(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const latestSync = dashboardData?.latest_sync;
  const recentLogs = dashboardData?.recent_logs || [];
  const statusCounts = latestSync?.status_counts || {};

  const statusDistributionRows = Object.entries(statusCounts).map(
    ([status, count]) => [status, <StatusBadge key={status} status={status} />, count]
  );

  const recentLogsRows = recentLogs.map((log) => [
    log.id,
    <StatusBadge key={log.id} status={log.status} />,
    log.sync_type || '—',
    log.orders_processed ?? '—',
    log.orders_updated ?? '—',
    log.orders_failed ?? '—',
    log.timestamp
      ? new Date(log.timestamp).toLocaleString()
      : '—',
  ]);

  if (loading) {
    return (
      <Page title="Dashboard">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <SkeletonDisplayText size="large" />
                <SkeletonBodyText lines={4} />
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section>
            <Card>
              <SkeletonBodyText lines={6} />
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Dashboard"
      primaryAction={{
        content: 'Refresh',
        onAction: fetchDashboard,
      }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner title="Error loading dashboard" tone="critical">
              {error}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Latest Sync Summary</Text>
              {latestSync ? (
                <InlineStack gap="300">
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Status</Text>
                        <Text as="p" variant="headingLg">
                          <StatusBadge status={latestSync.status} />
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Orders Processed</Text>
                        <Text as="p" variant="headingLg">
                          {latestSync.orders_processed ?? 0}
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Orders Updated</Text>
                        <Text as="p" variant="headingLg">
                          {latestSync.orders_updated ?? 0}
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Orders Failed</Text>
                        <Text as="p" variant="headingLg">
                          <Text as="span" tone="critical">
                            {latestSync.orders_failed ?? 0}
                          </Text>
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                </InlineStack>
              ) : (
                <Banner title="No sync data yet" tone="info">
                  Run your first sync from the Sync Control page to see summary data here.
                </Banner>
              )}
              {latestSync?.details && (
                <Text as="span" tone="subdued">{latestSync.details}</Text>
              )}
              {latestSync?.timestamp && (
                <Text as="span" tone="subdued">
                  Last synced: {new Date(latestSync.timestamp).toLocaleString()}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">Status Distribution</Text>
              {statusDistributionRows.length > 0 ? (
                <DataTable
                  columnContentTypes={['text', 'text', 'numeric']}
                  headings={['Status', 'Badge', 'Count']}
                  rows={statusDistributionRows}
                />
              ) : (
                <Text as="span" tone="subdued">
                  No status distribution data available. Run a sync first.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section oneHalf>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">Sync Info</Text>
              {latestSync ? (
                <DataTable
                  columnContentTypes={['text', 'text']}
                  headings={['Field', 'Value']}
                  rows={[
                    ['Sync Type', latestSync.sync_type || '—'],
                    ['Status', latestSync.status || '—'],
                    [
                      'Timestamp',
                      latestSync.timestamp
                        ? new Date(latestSync.timestamp).toLocaleString()
                        : '—',
                    ],
                    ['Details', latestSync.details || '—'],
                  ]}
                />
              ) : (
                <Text as="span" tone="subdued">No sync information available.</Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">Recent Sync Logs</Text>
              {recentLogsRows.length > 0 ? (
                <DataTable
                  columnContentTypes={[
                    'numeric',
                    'text',
                    'text',
                    'numeric',
                    'numeric',
                    'numeric',
                    'text',
                  ]}
                  headings={[
                    'ID',
                    'Status',
                    'Type',
                    'Processed',
                    'Updated',
                    'Failed',
                    'Timestamp',
                  ]}
                  rows={recentLogsRows}
                />
              ) : (
                <Text as="span" tone="subdued">
                  No sync logs yet. Start your first sync from the Sync Control page.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
