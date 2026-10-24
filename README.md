# Restaurant Order Management System

Hệ thống quản lý nhà hàng/order full-stack cho Đề 12.

## Công nghệ
- Backend: Node.js + Express
- Database: PostgreSQL
- Frontend: React + Vite
- Reverse proxy: Nginx
- Database admin: pgAdmin
- Monitoring: Prometheus + Grafana
- Logging: Loki + Promtail
- Triển khai: Docker Compose

## Chức năng hiện có
- Đăng nhập JWT, phân quyền ADMIN/STAFF.
- CRUD danh mục món ăn và món ăn.
- Quản lý bàn ăn và trạng thái bàn.
- Tạo order theo bàn, thêm món, cập nhật số lượng, chuyển trạng thái.
- Thanh toán đơn hàng, ghi nhận phương thức thanh toán.
- Dashboard doanh thu, số đơn, món bán chạy.
- PostgreSQL lưu dữ liệu; pgAdmin quản trị.
- Health endpoint và Prometheus metrics.
- Nginx reverse proxy; Prometheus/Grafana/Loki/Promtail.
- Seed tài khoản và dữ liệu mẫu.

## Chạy nhanh
Yêu cầu: Docker Desktop + Docker Compose.

1. Sao chép `.env.example` thành `.env`.
2. Đổi `JWT_SECRET`, mật khẩu database và mật khẩu pgAdmin trước khi dùng.
3. Chạy:
   ```bash
   docker compose up --build -d
   ```
4. Mở:
   - Ứng dụng: http://localhost
   - API health: http://localhost/api/health
   - pgAdmin: http://localhost:5050
   - Prometheus: http://localhost:9090
   - Grafana: http://localhost:3001
   - Loki: http://localhost:3100/ready

## Tài khoản demo
- Admin: `admin@restaurant.local` / `Admin123!`
- Nhân viên: `staff@restaurant.local` / `Staff123!`

Đổi mật khẩu/tài khoản demo ngay sau khi triển khai. Đây là dữ liệu phục vụ học tập, không phải cấu hình production.

## API chính
- `POST /api/auth/login`
- `GET/POST/PUT/DELETE /api/categories`
- `GET/POST/PUT/DELETE /api/menu`
- `GET/POST/PUT /api/tables`
- `GET/POST /api/orders`
- `POST /api/orders/:id/items`
- `PATCH /api/orders/:id/items/:itemId`
- `PATCH /api/orders/:id/status`
- `POST /api/orders/:id/pay`
- `GET /api/reports/summary`
- `GET /api/health`
- `GET /api/metrics`

Các API nghiệp vụ yêu cầu JWT, các API ghi/sửa/xóa món và danh mục yêu cầu ADMIN. Các API quản lý order yêu cầu ADMIN hoặc STAFF. Không mở cổng backend/database ra Internet khi triển khai thật; hãy dùng secrets riêng và TLS.

## Hardening checklist trước khi bảo vệ
- [ ] Đổi toàn bộ mật khẩu mặc định và JWT secret.
- [ ] Đặt firewall chỉ mở cổng cần thiết (80/443); không public pgAdmin, PostgreSQL, Prometheus, Grafana, Loki.
- [ ] Bật HTTPS/TLS ở Nginx.
- [ ] Dùng secret manager, backup PostgreSQL và kiểm tra khôi phục.
- [ ] Rà soát CORS, rate limit, log không chứa token/mật khẩu.
- [ ] Dùng tài khoản DB ít quyền nhất, không dùng tài khoản superuser cho ứng dụng.
- [ ] Cập nhật image/package và chạy kiểm thử bảo mật.
