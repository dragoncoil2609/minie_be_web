# --- Stage 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /app

# 1. Cài đặt dependencies
COPY package*.json ./
RUN npm ci

# 2. Copy source code
COPY . .

# 3. Build code
# Lệnh này sẽ chạy "nest build".
# QUAN TRỌNG: Nếu lệnh "build" trong package.json chưa bao gồm copy email templates,
# bạn hãy bỏ comment dòng dưới đây để chạy thêm lệnh copy:
# RUN npm run copy:templates
RUN npm run build

# --- Stage 2: Production Run ---
FROM node:18-alpine

WORKDIR /app

# 1. Set biến môi trường production
ENV NODE_ENV=production

# 2. Copy file build từ Stage 1
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# 3. Tạo thư mục uploads (để tránh lỗi nếu chưa mount volume)
RUN mkdir -p uploads

# 4. Mở port (Document)
EXPOSE 3000

# 5. Chạy app
CMD ["node", "dist/main.js"]
