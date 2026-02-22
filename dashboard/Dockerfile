# SwarmTrade Dashboard Dockerfile
# Builds the React/Vite dashboard and serves it via nginx

FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies needed for build)
COPY dashboard/package*.json ./
RUN npm ci

# Copy source and build
COPY dashboard/ .

# Vite build requires env vars at build time (they're baked into the bundle)
# If not available at build time, placeholders will be replaced at runtime
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

# Copy runtime entrypoint script that injects env vars
COPY dashboard/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
