#!/bin/sh
# Runtime environment variable injection for Vite apps
# Replaces placeholder strings in the built JS with actual Railway env vars

set -e

echo "================================================"
echo "SwarmTrade Dashboard - Runtime Configuration"
echo "================================================"

# Railway provides PORT env var - use it if available, otherwise default to 80
NGINX_PORT=${PORT:-80}
echo "Port configuration: ${NGINX_PORT}"

# Check if env vars are set - warn but don't exit (nginx should still start)
if [ -z "$VITE_SUPABASE_URL" ] || [ -z "$VITE_SUPABASE_ANON_KEY" ]; then
    echo "WARNING: Required environment variables are not set!"
    echo "VITE_SUPABASE_URL: ${VITE_SUPABASE_URL:-NOT SET}"
    echo "VITE_SUPABASE_ANON_KEY: ${VITE_SUPABASE_ANON_KEY:+SET (hidden)}"
    echo "Dashboard will start but may not function correctly."
    echo "Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Railway."
else
    echo "Environment variables detected:"
    echo "VITE_SUPABASE_URL: ${VITE_SUPABASE_URL}"
    echo "VITE_SUPABASE_ANON_KEY: SET (hidden)"
fi

# Update nginx to listen on Railway's PORT
if [ "$NGINX_PORT" != "80" ]; then
    echo "Configuring nginx to listen on port ${NGINX_PORT}..."
    sed -i "s|listen 80;|listen ${NGINX_PORT};|g" /etc/nginx/conf.d/default.conf
fi

# Find the main JS file in the dist directory (only inject if env vars are available)
if [ -n "$VITE_SUPABASE_URL" ] && [ -n "$VITE_SUPABASE_ANON_KEY" ]; then
    echo "Searching for JS bundle..."
    MAIN_JS=$(find /usr/share/nginx/html/assets -name 'index-*.js' 2>/dev/null | head -1)

    if [ -z "$MAIN_JS" ]; then
        echo "WARNING: Could not find main JS file in /usr/share/nginx/html/assets"
        ls -la /usr/share/nginx/html/assets/ || echo "Assets directory not found"
    else
        echo "Found JS bundle: $MAIN_JS"

        # Check if placeholders exist in the bundle
        if grep -q "__VITE_SUPABASE_URL__" "$MAIN_JS"; then
            echo "Replacing placeholders with runtime values..."
            sed -i "s|__VITE_SUPABASE_URL__|${VITE_SUPABASE_URL}|g" "$MAIN_JS"
            sed -i "s|__VITE_SUPABASE_ANON_KEY__|${VITE_SUPABASE_ANON_KEY}|g" "$MAIN_JS"
            echo "✓ Environment variables injected successfully"
        else
            echo "Note: Placeholders not found - build-time env vars may have been used"
        fi
    fi
fi

echo "================================================"
echo "Starting nginx on port ${NGINX_PORT}..."
echo "================================================"

# Start nginx (always, even if env var injection failed)
exec nginx -g 'daemon off;'
