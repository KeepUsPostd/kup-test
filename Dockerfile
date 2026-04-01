FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./

# Use npm install (not npm ci) — avoids platform-specific lockfile conflicts
# between macOS-generated lock files and the Linux build environment
RUN npm install --omit=dev

# Copy the rest of the source
COPY . .

# Railway sets PORT automatically; server.js reads process.env.PORT
EXPOSE 3001

CMD ["node", "src/server.js"]
