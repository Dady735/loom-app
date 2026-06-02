import React, { useState, useEffect, useCallback } from 'react';
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  DataTable,
  Badge,
  Spinner,
  Banner,
  Select,
  Button,
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

export default function LogViewer() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [reportData, setReportData] = useState({});
  const [reportLoading, setReportLoading] = useState({});

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/api/logs?limit=50`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      setLogs(data.logs || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const fetchReport = useCallback(async (syncLogId) => {
    setReportLoading((prev) => ({ ...prev, [syncLogId]: true }));
    try {
      const response = await fetch(
        `${API_URL}/api/report?sync_log_id=${syncLogId}&limit=100`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      setReportData((prev) => ({ ...prev, [syncLogId]: data.report || [] }));
    } catch (err) {
      setReportData((prev) => ({
        ...prev,
        [syncLogId]: { error: err.message },
      }));
    } finally {
      setReportLoading((prev) => ({ ...prev, [syncLogId]: false }));
    }
  }, []);

  const handleToggleExpand = useCallback(
    (logId) => {
      if (expandedLogId === logId) {
        setExpandedLogId(null);
      } else {
        setExpandedLogId(logId);
        if (!reportData[logId] && !reportLoading[logId]) {
          fetchReport(logId);
        }
      }
    },
    [expandedLogId, reportData, reportLoading, fetchReport]
  );

  const handleStatusFilterChange = useCallback((value) => {
    setStatusFilter(value);
  }, []);

  const filteredLogs = logs.filter((log) => {
    if (statusFilter === 'all') return true;
    return log.status === statusFilter;
  });

  const logRows = filteredLogs.map((log) => [
    <Button
      key={`expand-${log.id}`}
      variant="plain"
      onClick={() => handleToggleExpand(log.id)}
    >
      {expandedLogId === log.id ? '▼' : '▶'} #{log.id}
    </Button>,
    <StatusBadge key={`status-${log.id}`} status={log.status} />,
    log.sync_type || '—',
    log.orders_processed ?? '—',
    log.orders_updated ?? '—',
    log.orders_failed ?? '—',
    log.timestamp ? new Date(log.timestamp).toLocaleString() : '—',
  ]);

  const statusOptions = [
    { label: 'All statuses', value: 'all' },
    { label: 'Completed', value: 'completed' },
    { label: 'Running', value: 'running' },
    { label: 'Failed', value: 'failed' },
    { label: 'Pending', value: 'pending' },
  ];

  const renderExpandedReport = (logId) => {
    const report = reportData[logId];

    if (reportLoading[logId]) {
      return (
        <div style={{ padding: '1rem 0' }}>
          <InlineStack align="center" blockAlign="center" gap="300">
            <Spinner size="small" />
            <Text as="span" tone="subdued">Loading report entries…</Text>
          </InlineStack>
        </div>
      );
    }

    if (!report) return null;

    if (report.error) {
      return (
        <Banner title="Error loading report" tone="critical">
          {report.error}
        </Banner>
      );
    }

    if (!Array.isArray(report) || report.length === 0) {
      return (
        <Text as="span" tone="subdued">
          No report entries for this sync log.
        </Text>
      );
    }

    const reportRows = report.map((entry) => [
      entry.order_number || '—',
      entry.order_name || '—',
      entry.tracking_number || '—',
      <StatusBadge key={`pe-${entry.id}`} status={entry.postex_status} />,
      <StatusBadge key={`ss-${entry.id}`} status={entry.shopify_status} />,
      entry.rule || '—',
      entry.message || '—',
      entry.shipping_city || '—',
    ]);

    return (
      <div style={{ marginTop: '1rem' }}>
        <DataTable
          columnContentTypes={[
            'text',
            'text',
            'text',
            'text',
            'text',
            'text',
            'text',
            'text',
          ]}
          headings={[
            'Order #',
            'Order Name',
            'Tracking #',
            'PostEx Status',
            'Shopify Status',
            'Rule',
            'Message',
            'City',
          ]}
          rows={reportRows}
          truncate
        />
      </div>
    );
  };

  if (loading) {
    return (
      <Page title="Log Viewer">
        <Layout>
          <Layout.Section>
            <Card>
              <SkeletonBodyText lines={8} />
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Log Viewer"
      primaryAction={{
        content: 'Refresh',
        onAction: fetchLogs,
      }}
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner title="Error loading logs" tone="critical">
              {error}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <InlineStack align="end" blockAlign="center" gap="300">
              <div style={{ minWidth: '180px' }}>
                <Select
                  label="Filter by status"
                  options={statusOptions}
                  value={statusFilter}
                  onChange={handleStatusFilterChange}
                />
              </div>
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              {logRows.length > 0 ? (
                <>
                  <DataTable
                    columnContentTypes={[
                      'text',
                      'text',
                      'text',
                      'numeric',
                      'numeric',
                      'numeric',
                      'text',
                    ]}
                    headings={[
                      'Log ID',
                      'Status',
                      'Type',
                      'Processed',
                      'Updated',
                      'Failed',
                      'Timestamp',
                    ]}
                    rows={logRows}
                    truncate
                  />
                  <Text as="span" tone="subdued">
                    Showing {filteredLogs.length} of {logs.length} logs. Click a Log ID to expand
                    report entries.
                  </Text>
                </>
              ) : (
                <Text as="span" tone="subdued">
                  No sync logs found. Run your first sync from the Sync Control page.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {expandedLogId !== null && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Report for Sync Log #{expandedLogId}</Text>
                {renderExpandedReport(expandedLogId)}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
