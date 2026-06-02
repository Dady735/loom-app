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
} from '@shopify/polaris';
import { AlertTriangleIcon } from '@shopify/polaris-icons';

const API_URL = process.env.REACT_APP_API_URL || '';

export default function ManualOverride() {
  const [orderNumber, setOrderNumber] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [submitError, setSubmitError] = useState(null);

  const handleOrderNumberChange = useCallback((value) => {
    setOrderNumber(value);
  }, []);

  const handleTrackingNumberChange = useCallback((value) => {
    setTrackingNumber(value);
  }, []);

  const handleReasonChange = useCallback((value) => {
    setReason(value);
  }, []);

  const handleMarkAsFailed = useCallback(async () => {
    if (!orderNumber.trim() && !trackingNumber.trim()) {
      setSubmitError('Provide an order number or a tracking number.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setResult(null);

    const payload = {
      reason: reason.trim() || 'Manual override',
    };

    if (orderNumber.trim()) {
      payload.order_number = orderNumber.trim();
    }
    if (trackingNumber.trim()) {
      payload.tracking_number = trackingNumber.trim();
    }

    try {
      const response = await fetch(`${API_URL}/api/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setResult(data);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }, [orderNumber, trackingNumber, reason]);

  const handleReset = useCallback(() => {
    setOrderNumber('');
    setTrackingNumber('');
    setReason('');
    setResult(null);
    setSubmitError(null);
  }, []);

  return (
    <Page title="Manual Override">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Mark Order as Failed</Text>
              <Text as="span" tone="subdued">
                Manually override an order's fulfillment status to FAILURE in Shopify.
                Provide either an order number or a tracking number (or both).
                This action is logged in the sync report.
              </Text>

              <InlineStack gap="300">
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Order Number"
                    value={orderNumber}
                    onChange={handleOrderNumberChange}
                    placeholder="e.g. 1077"
                    autoComplete="off"
                    helpText="The Shopify order number (without #)"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Tracking Number"
                    value={trackingNumber}
                    onChange={handleTrackingNumberChange}
                    placeholder="e.g. 27218850025631"
                    autoComplete="off"
                    helpText="The PostEx tracking number"
                  />
                </div>
              </InlineStack>

              <TextField
                label="Reason"
                value={reason}
                onChange={handleReasonChange}
                multiline={3}
                placeholder="e.g. Customer refused delivery"
                autoComplete="off"
                helpText="A short explanation for this manual override"
              />

              <InlineStack align="end" gap="300">
                <Button onClick={handleReset} disabled={submitting}>
                  Reset
                </Button>
                <Button
                  variant="primary"
                  tone="critical"
                  onClick={handleMarkAsFailed}
                  disabled={
                    submitting ||
                    (!orderNumber.trim() && !trackingNumber.trim())
                  }
                  icon={AlertTriangleIcon}
                >
                  {submitting ? 'Processing…' : 'Mark as Failed'}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {submitError && (
          <Layout.Section>
            <Banner title="Override failed" tone="critical">
              {submitError}
            </Banner>
          </Layout.Section>
        )}

        {result && !submitting && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Banner title="Order marked as failed" tone="success">
                  The fulfillment status has been updated to FAILURE in Shopify.
                </Banner>
                <InlineStack gap="300">
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Status</Text>
                        <Text as="p" variant="headingLg">
                          {result.status || '—'}
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Shopify Status</Text>
                        <Text as="p" variant="headingLg">
                          {result.shopify_status || '—'}
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="span" tone="subdued">Reason</Text>
                        <Text as="p" variant="headingLg">
                          {result.reason || '—'}
                        </Text>
                      </BlockStack>
                    </Card>
                  </div>
                </InlineStack>
                {(result.order_number || result.tracking_number) && (
                  <InlineStack gap="300">
                    {result.order_number && (
                      <div style={{ flex: 1 }}>
                        <Card>
                          <BlockStack gap="200">
                            <Text as="span" tone="subdued">Order Number</Text>
                            <Text as="p" variant="headingMd">
                              {result.order_number}
                            </Text>
                          </BlockStack>
                        </Card>
                      </div>
                    )}
                    {result.tracking_number && (
                      <div style={{ flex: 1 }}>
                        <Card>
                          <BlockStack gap="200">
                            <Text as="span" tone="subdued">Tracking Number</Text>
                            <Text as="p" variant="headingMd">
                              {result.tracking_number}
                            </Text>
                          </BlockStack>
                        </Card>
                      </div>
                    )}
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {submitting && (
          <Layout.Section>
            <Card>
              <InlineStack align="center" blockAlign="center" gap="300">
                <Spinner accessibilityLabel="Processing override" size="large" />
                <Text as="p" variant="headingLg">Processing override…</Text>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Important Notes</Text>
              <ul style={{ paddingLeft: '1.25rem', color: 'var(--p-color-text-subdued)' }}>
                <li>
                  This action will set the Shopify fulfillment event status to{' '}
                  <Text as="span" fontWeight="bold">FAILURE</Text>.
                </li>
                <li>
                  The override is logged in the sync report with the reason you provide.
                </li>
                <li>
                  You need to provide at least an order number <strong>or</strong> a tracking number.
                </li>
                <li>
                  If both are provided, the tracking number takes precedence for matching.
                </li>
                <li>
                  This action cannot be automatically reversed. You would need to re-sync or manually
                  update the fulfillment status in Shopify.
                </li>
              </ul>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
