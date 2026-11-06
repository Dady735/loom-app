export type Role = 'owner' | 'supervisor' | 'staff';
export type OrderStatus = 'ready' | 'packed' | 'dispatched' | 'review';
export type Permission = 'import' | 'assign' | 'verify' | 'pack' | 'dispatch' | 'check' | 'reconcile' | 'reports' | 'staff' | 'settings' | 'activity';
export interface User { id: string; name: string; email: string; role: Role; active: boolean; createdAt: string; lastLoginAt: string | null }
export interface SessionInfo { user: User | null; csrf: string | null; setupRequired: boolean; setupKeyRequired: boolean; brand: string }
export interface Settings {
  timezone: string; cutoff: string; autoSync: boolean; syncMinutes: number;
  dispatchToShopify: boolean; notifyCustomer: boolean; allowCOD: boolean;
  couriers: string[]; shopDomain: string; connected: boolean; shopName: string;
  lastSyncAt: string | null; lastSyncError: string | null; webhookEnabled: boolean;
  lastWebhookAt: string | null; lastBackupAt: string | null;
}
export interface OrderItem {
  id: string; title: string; variant: string; size: string; color: string; sku: string; barcode: string;
  quantity: number; currentQuantity: number; requiresShipping: boolean;
  verifiedQuantity: number; attributesVerified: boolean; verifiedBy: string | null; verifiedAt: string | null;
}
export interface Order {
  id: string; name: string; numericId: string; createdAt: string; updatedAt: string; importedAt: string;
  customerName: string; city: string; customer?: { email: string; phone: string; address: string };
  financialStatus: string; fulfillmentStatus: string; cancelledAt: string | null;
  tags: string[]; note: string; total: string; currency: string; gateways: string[];
  status: OrderStatus; cn: string; courier: string; trackingUrl: string; cnConflict: string;
  version: number; dueDate: string; firstQueuedAt: string;
  packedAt: string | null; packedBy: string | null; dispatchedAt: string | null; dispatchedBy: string | null;
  reviewReason: string; shopifySyncStatus: string; shopifySyncError: string | null;
  items: OrderItem[];
  pendingSince?: string; checkedAt?: string | null; checkedBy?: string | null; checkNote?: string;
}
export interface OrderEvent { id: number; orderId: string | null; orderName?: string; actorName: string; actorId: string | null; type: string; detail: Record<string, unknown>; createdAt: string }
export interface Dashboard {
  total: number; ready: number; packed: number; dispatched: number; pending: number; review: number;
  packedToday: number; dispatchedToday: number; importedToday: number; pendingVerifiedToday: number;
  carriedForward: number; dueToday: number; dispatchRate: number; unitsDispatchedToday: number;
  trend: { day: string; label: string; packed: number; dispatched: number; imported: number }[];
  activity: OrderEvent[]; staff: { id: string; name: string; role: Role; packed: number; dispatched: number; lastActive: string | null }[];
  today: string; timezone: string; lastSyncAt: string | null; lastSyncError: string | null; connected: boolean;
  failedSyncs: number; backupAt: string | null; syncing?: boolean;
}
export interface Paginated<T> { rows: T[]; total: number; page: number; pageSize: number }
export interface PendingSnapshot { day: string; orderId: string; status: string; checkedAt: string | null; checkedBy: string | null; note: string; resolvedAt: string | null; order: Order }
