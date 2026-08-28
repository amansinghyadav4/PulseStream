# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY . .
RUN npm run build

# Runtime stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# SPA fallback + API/WS proxy with Docker-DNS re-resolution and server-side
# X-API-Key injection (envsubst template; see nginx.conf.template)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80
