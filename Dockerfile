# ============================================
# FaserCDN Standalone - Dockerfile
# ============================================

# --- Build Stage ---
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for native modules (sharp)
RUN apk add --no-cache python3 make g++ 

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# --- Production Stage ---
FROM node:22-alpine AS production

WORKDIR /app

# Install runtime dependencies for sharp
RUN apk add --no-cache vips-dev

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY --chown=nodejs:nodejs . .

# Remove unnecessary files
RUN rm -rf .git .env .env.* *.md

# Switch to non-root user
USER nodejs

# Expose port (default 3200)
EXPOSE 3200

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3200}/health || exit 1

# Start the server
CMD ["node", "index.js"]
