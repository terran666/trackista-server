FROM node:20-alpine

WORKDIR /app

# Install dependencies first — benefits from Docker layer cache
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

CMD ["npm", "start"]
