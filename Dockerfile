# --- Giai đoạn 1: Build Source Code ---
    FROM node:18-alpine AS builder

    WORKDIR /app
    
    # Copy file package để cài thư viện trước (Tối ưu cache layer)
    COPY package*.json ./
    # Dùng npm ci để cài chính xác phiên bản trong lock file
    RUN npm ci
    
    # Copy toàn bộ code vào
    COPY . .
    
    # Build NestJS (Output ra thư mục dist)
    # LƯU Ý: Đảm bảo script "build" trong package.json đã bao gồm việc copy templates email
    # Nếu chưa, bạn có thể thêm dòng: RUN npm run copy:templates (nếu có lệnh này)
    RUN npm run build
    
    # --- Giai đoạn 2: Chạy ứng dụng (Production) ---
    FROM node:18-alpine
    
    WORKDIR /app
    
    # Thiết lập biến môi trường mặc định
    ENV NODE_ENV=production
    
    # Copy thư viện và code đã build từ giai đoạn 1
    COPY --from=builder /app/node_modules ./node_modules
    COPY --from=builder /app/dist ./dist
    COPY --from=builder /app/package.json ./
    
    # Tạo thư mục uploads để tránh lỗi nếu chưa có volume mount
    RUN mkdir -p uploads
    
    # Expose port 3000
    EXPOSE 3000
    
    # Lệnh chạy server
    CMD ["node", "dist/main.js"]