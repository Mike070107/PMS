# API Progress

## Implemented

### Auth

- `POST /api/v1/auth/bootstrap-admin`
  - Creates the first tenant and tenant admin.
  - Disabled unless `BOOTSTRAP_TOKEN` is set.
- `POST /api/v1/auth/admin-login`
  - Logs in an admin-side account with `loginAccount` and password.
  - Returns a Bearer JWT.
- `GET /api/v1/auth/me`
  - Returns the current JWT user profile.
  - For owners it also returns `place`: the community / building / room bound (or applied for) by the owner plus the onboarding audit status. The owner mini program uses it to show the home badge and to file a repair without scanning a QR code. `null` when the owner has never submitted onboarding.

### Upload

- `POST /api/v1/upload`
  - JWT required.
  - Multipart field: `file`.
  - Supports both production `COS_*` env vars and local `MINIO_*` env vars.

### Dashboard

- `GET /api/v1/dashboard/metrics`
  - Returns admin dashboard counters for pending dispatch work orders, material-waiting work orders, owner-review work orders, pending owner audits, and pending purchase approvals.
  - JWT required.

### Property Foundation

- `GET /api/v1/communities`
- `POST /api/v1/communities`
- `GET /api/v1/buildings`
- `POST /api/v1/buildings`
- `GET /api/v1/houses`
- `POST /api/v1/houses`

These endpoints are guarded by JWT and `admin | manager | superadmin`.

### QR Codes

- `POST /api/v1/qr-codes`
  - Creates a community-level or building-level QR code.
  - Generates a token and attempts to upload a QR PNG to object storage.
- `GET /api/v1/qr/:token`
  - Public QR parser for miniapp entry.

### Owner Onboarding

- `POST /api/v1/owners/register`
  - Creates or reuses an owner user and creates a pending audit.
- `GET /api/v1/audits?status=pending`
- `POST /api/v1/audits/:id/approve`
- `POST /api/v1/audits/:id/reject`

### Repair Requests and Work Orders

- `POST /api/v1/repair-requests`
  - Owner-side repair submission.
  - Creates a `repair_requests` row, a `work_orders` row in `created` status, and an initial `work_order_logs` row.
- `POST /api/v1/repair-requests/office`
  - Office-side repair submission with the same work-order creation behavior.
- `GET /api/v1/work-orders?status=created&communityId=1&scope=pool`
  - Lists work orders. Visible range is narrowed by role:
    - `admin | manager | office`: every work order of the tenant.
    - `technician`: `scope=pool` returns unassigned `created | dispatched` orders (grab pool); anything else returns orders assigned to the caller.
    - `owner`: only work orders created from the caller's own repair requests (`scope` ignored).
- `GET /api/v1/work-orders/:id`
  - Returns a work order with its source repair request and status logs.
  - Owners get `404` for work orders they did not submit.
- `POST /api/v1/work-orders/:id/assign`
  - Admin-side manual dispatch or reassignment to a technician.
- `POST /api/v1/work-orders/:id/accept`
  - Technician accepts a dispatched work order.
  - If the work order is still unassigned, a technician claims it from the pool: the caller becomes the assignee and the order moves to `in_progress` (row-locked, so only the first caller wins).
- `POST /api/v1/work-orders/:id/complete`
  - Technician submits completion details, fees, attachments, and used materials.
- `POST /api/v1/work-orders/:id/need-material`
  - Marks the work order as waiting for materials and creates a manager-review purchase request.
- `POST /api/v1/work-orders/:id/review`
  - Owner acceptance review; moves the work order to `completed`.

## Suggested Manual Smoke Flow

1. Set `BOOTSTRAP_TOKEN` in `apps/api/.env`.
2. Start the API against a safe dev database.
3. Call `POST /auth/bootstrap-admin`.
4. Call `POST /auth/admin-login` and copy the returned Bearer token.
5. Create a community, building, and house.
6. Create a QR code.
7. Resolve the QR token.
8. Submit owner registration.
9. Approve or reject the audit.
10. Submit a repair request and confirm a `created` work order appears.
11. Assign, accept, complete, and review the work order.

### Inventory and Purchasing

- `GET /api/v1/materials`
- `POST /api/v1/materials`
- `GET /api/v1/warehouses`
- `POST /api/v1/warehouses`
- `GET /api/v1/suppliers`
- `POST /api/v1/suppliers`
- `GET /api/v1/stocks`
- `GET /api/v1/purchase-requests?status=manager_review`
- `POST /api/v1/purchase-requests/:id/manager-approve`
- `POST /api/v1/purchase-requests/:id/purchaser-approve`
- `POST /api/v1/purchase-requests/:id/reject`
- `GET /api/v1/purchase-orders`
- `POST /api/v1/purchase-orders`
- `POST /api/v1/goods-receipts`
  - Creates a receipt, increments stock, writes stock movement records, and marks the purchase order as received.
- `GET /api/v1/transfer-orders`
- `POST /api/v1/transfer-orders`
- `POST /api/v1/transfer-orders/:id/ship`
  - Decrements source warehouse stock and writes transfer movement records.
- `POST /api/v1/transfer-orders/:id/receive`
  - Increments destination warehouse stock and writes transfer movement records.

## Verification

- TypeScript typecheck passes.
- Nest build passes.
- Admin web typecheck passes.
- Admin web production build passes.
- TypeORM read-only database connectivity check passed against the configured database.

HTTP smoke testing was not run because the current `.env` points to a remote database with `DB_SYNCHRONIZE=true`; starting the API could alter that schema.
