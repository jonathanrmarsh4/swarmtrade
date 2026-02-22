# SwarmTrade Dashboard Dockerfile
# Builds the React/Vite dashboard and serves it via nginx

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY dashboard/package*.json ./
RUN npm ci --only=production

# Copy source and build
COPY dashboard/ .

# Vite build requires env vars at build time (they're baked into the bundle)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm run build

# Production stage - serve with nginx
FROM nginx:alpine

# Copy built assets from builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config for SPA routing
COPY dashboard/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
