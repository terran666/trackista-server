FROM node:20-alpine

# vips is required by sharp for image processing on Alpine
RUN apk add --no-cache vips-dev python3 make g++

WORKDIR /app

# Install dependencies first — benefits from Docker layer cache
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure media directory exists in image (bind-mounted at runtime)
RUN mkdir -p /app/media

EXPOSE 3000

CMD ["npm", "start"]
