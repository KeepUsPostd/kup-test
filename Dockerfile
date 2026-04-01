FROM node:22-slim

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Use node:22-slim (Debian/glibc) so the `canvas` package can use its
# prebuilt binaries — Alpine (musl) has no prebuilts and node-gyp fails.
# Use npm install (not npm ci) to avoid macOS↔Linux lockfile sync issues.
RUN npm install --omit=dev

# Copy the rest of the source
COPY . .

# Railway sets PORT automatically; server.js reads process.env.PORT
EXPOSE 3001

CMD ["node", "src/server.js"]
