# API quick reference

All protected routes require `Authorization: Bearer <JWT>`.

## Auth
`POST /api/auth/login` body `{ "email": "...", "password": "..." }`

## Menu and categories (ADMIN for write)
- `GET /api/menu?search=...&available=true`
- `POST /api/menu` body `{ "name": "Mì xào", "category_id": 1, "price": 45000, "description": "...", "available": true }`
- `PUT /api/menu/:id`, `DELETE /api/menu/:id`
- `GET /api/categories`
- `POST /api/categories` body `{ "name": "Lẩu", "description": "..." }`
- `PUT /api/categories/:id`, `DELETE /api/categories/:id`

## Tables
- `GET /api/tables`
- `POST /api/tables` (ADMIN) body `{ "table_number": 13, "capacity": 4 }`
- `PUT /api/tables/:id` (ADMIN) body `{ "status": "AVAILABLE", "capacity": 4 }`

## Orders
- `GET /api/orders`, `GET /api/orders/:id`
- `POST /api/orders` body `{ "table_id": 1, "items": [{ "menu_item_id": 1, "quantity": 2, "note": "" }], "note": "" }`
- `POST /api/orders/:id/items` body `{ "menu_item_id": 1, "quantity": 1 }`
- `PATCH /api/orders/:id/items/:itemId` body `{ "quantity": 3, "note": "" }`
- `PATCH /api/orders/:id/status` body `{ "status": "PREPARING" }`
- `POST /api/orders/:id/pay` body `{ "method": "CASH" }`, method: `CASH`, `CARD`, `TRANSFER`

## Reporting and monitoring
- `GET /api/reports/summary?from=2026-10-22&to=2026-10-22` (ADMIN)
- `GET /api/audit-logs` (ADMIN)
- `GET /api/health`
- `GET /api/metrics`

## Statuses
Order: `OPEN`, `PREPARING`, `READY`, `SERVED`, `PAID`, `CANCELLED`.
Table: `AVAILABLE`, `OCCUPIED`, `RESERVED`, `CLEANING`.
