#!/bin/sh
# Runtime environment variable injection for Vite apps
# Replaces placeholder strings in the built JS with actual Railway env vars

set -e

echo "Injecting runtime environment variables..."

# Find the main JS file in the dist directory
MAIN_JS=$(find /usr/share/nginx/html/assets -name 'index-*.js' | head -1)

if [ -z "$MAIN_JS" ]; then
    echo "ERROR: Could not find main JS file"
    exit 1
fi

echo "Found JS bundle: $MAIN_JS"

# Replace placeholders with actual env var values
sed -i "s|__VITE_SUPABASE_URL__|${VITE_SUPABASE_URL}|g" "$MAIN_JS"
sed -i "s|__VITE_SUPABASE_ANON_KEY__|${VITE_SUPABASE_ANON_KEY}|g" "$MAIN_JS"

echo "Environment variables injected successfully"
echo "Starting nginx..."

# Start nginx
exec nginx -g 'daemon off;'
