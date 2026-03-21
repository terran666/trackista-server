# Trackista Production Setup Guide

## Architecture Overview

### Local Development
- **Frontend**: Vite dev server with proxy to backend
- **Backend**: Docker container on port 3000
- **Access**: Direct to services (frontend dev server proxies API calls)

### Production
- **Nginx**: Reverse proxy on port 8080
  - Routes `/api/*` → backend:3000
  - Routes `/ws/*` → backend:3000 (WebSocket)
  - Serves frontend static files from `./frontend/dist`
- **Backend**: Docker container (not directly exposed)
- **Access**: All traffic through nginx (single entry point)

## Quick Start

### Local Development (unchanged)
```bash
# Start all services WITHOUT nginx
docker compose up -d

# Backend available at: http://localhost:3000
# Frontend dev server handles proxy separately
```

### Production
```bash
# 1. Build your frontend
cd /path/to/your/frontend
npm run build

# 2. Copy build to ./frontend/dist
cp -r build/* /path/to/trackista-server/frontend/dist/

# 3. Start services WITH nginx
docker compose --profile production up -d

# Access application at: http://localhost:8080
```

## File Structure

```
trackista-server/
├── nginx/
│   └── nginx.conf          # Production nginx configuration
├── frontend/
│   └── dist/               # Frontend build output goes here
│       └── index.html      # Placeholder (replace with real build)
├── backend/                # Backend API server
├── collector/              # Data collector service
├── docker-compose.yml      # All services including nginx
└── README_PRODUCTION.md    # This file
```

## API Routes (Backend)

All HTTP endpoints use `/api/*` prefix:
- `/api/binance/*` - Binance REST proxy
- `/api/autolevels` - AutoLevels engine  
- `/api/saved-rays` - Saved rays CRUD
- `/api/tracked-levels` - Tracked levels
- `/api/tracked-extremes` - Tracked extremes
- `/api/tracked-rays` - Tracked rays
- `/api/manual-levels` - Manual levels
- `/api/manual-sloped-levels` - Manual sloped levels
- `/api/orderbook` - Orderbook data
- `/api/walls` - Wall detection
- `/api/density-*` - Density analysis
- `/api/posts` - Social feed
- `/api/auth` - Authentication

WebSocket endpoints use `/ws/*` prefix:
- `/ws/stream/*` - Binance spot WebSocket proxy
- `/ws/fstream/*` - Binance futures WebSocket proxy

## Nginx Configuration Highlights

### API Proxy
```nginx
location /api/ {
    proxy_pass http://backend;  # No trailing slash = preserve full path
    # ... headers ...
}
```

**Critical**: `proxy_pass http://backend;` (no trailing slash) preserves the `/api` prefix when forwarding to backend. This is required because backend routes expect `/api/*` paths.

### WebSocket Proxy
```nginx
location /ws/ {
    proxy_pass http://backend;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_read_timeout 3600s;
}
```

### SPA Fallback
```nginx
location / {
    try_files $uri $uri/ /index.html;  # Client-side routing
}
```

**Important**: `/api/*` and `/ws/*` are matched BEFORE the catch-all `/`, preventing SPA from intercepting API/WS requests.

## Deployment Checklist

### For Production Deployment:

1. **Build Frontend**
   ```bash
   # In your frontend project
   npm run build
   ```

2. **Copy Build to Server**
   ```bash
   # Copy all files to ./frontend/dist/
   cp -r build/* ./frontend/dist/
   ```

3. **Update Environment Variables**
   ```bash
   # Edit .env file with production values
   NODE_ENV=production
   JWT_SECRET=<strong-secret-here>
   MYSQL_ROOT_PASSWORD=<strong-password>
   MINIO_ROOT_USER=<custom-user>
   MINIO_ROOT_PASSWORD=<strong-password>
   ```

4. **Start Production Stack**
   ```bash
   docker compose --profile production up -d
   ```

5. **Verify Services**
   ```bash
   # Check all containers running
   docker compose ps
   
   # Test nginx health
   curl http://localhost:8080/nginx-health
   
   # Test backend through nginx
   curl http://localhost:8080/api/health
   
   # Test Binance proxy
   curl "http://localhost:8080/api/binance/spot/v3/exchangeInfo?symbol=BTCUSDT"
   ```

6. **Check Logs**
   ```bash
   docker compose logs nginx
   docker compose logs backend
   ```

## Troubleshooting

### 404 on API Requests
- **Symptom**: `/api/*` returns 404 or HTML instead of JSON
- **Cause**: Requests falling through to SPA fallback
- **Fix**: Verify nginx config has `/api/` location before `/` location
- **Test**: `curl http://localhost:8080/api/health` should return JSON

### WebSocket Connection Failed
- **Symptom**: Browser shows WebSocket connection error
- **Cause**: Missing upgrade headers or `/ws/*` falling to SPA
- **Fix**: Verify nginx `/ws/` location has `Upgrade` and `Connection` headers
- **Test**: Check browser DevTools Network tab for 101 Switching Protocols

### HTML Returned Instead of JSON
- **Symptom**: API returns index.html content
- **Cause**: nginx `try_files` matching API paths
- **Fix**: Ensure `/api/` location is matched with higher priority
- **Verify**: Check nginx error log for route matching

### Backend Not Reachable
- **Symptom**: nginx returns 502 Bad Gateway
- **Cause**: Backend container not running or wrong service name
- **Fix**: 
  ```bash
  # Check backend is running
  docker compose ps backend
  
  # Verify network connectivity
  docker compose exec nginx wget -O- http://trackista-backend:3000/health
  ```

### Local Dev Broken After Adding Nginx
- **Symptom**: Local development doesn't work anymore
- **Fix**: Use standard docker compose without profile:
  ```bash
  # Without nginx (local dev)
  docker compose up -d
  
  # With nginx (production)
  docker compose --profile production up -d
  ```

## Port Reference

### Local Development
- `3000` - Backend API (direct)
- `3306` - MySQL
- `6379` - Redis  
- `9000` - MinIO API
- `9001` - MinIO Console

### Production
- `8080` - Nginx (public entry point)
  - Proxies to backend internally
  - Serves frontend static files
- Backend port 3000 is NOT exposed (access only through nginx)

## Security Notes

### Production Recommendations:
1. Change default passwords in `.env`
2. Use strong `JWT_SECRET`
3. Configure firewall to only expose port 80/443
4. Add SSL/TLS termination in nginx
5. Set `NODE_ENV=production`
6. Use read-only volumes where possible
7. Implement rate limiting (already in backend)

### SSL/TLS Setup (Optional)
To add HTTPS, update nginx config:
```nginx
server {
    listen 443 ssl http2;
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    # ... rest of config ...
}
```

Mount certificates in docker-compose.yml:
```yaml
nginx:
  volumes:
    - ./ssl:/etc/nginx/ssl:ro
```

## Monitoring

### Health Checks
```bash
# Nginx
curl http://localhost:8080/nginx-health

# Backend through nginx
curl http://localhost:8080/api/health

# Backend direct (if port exposed)
curl http://localhost:3000/health
```

### Container Status
```bash
docker compose ps
docker compose logs -f nginx
docker compose logs -f backend
```

### View Active Connections
```bash
# Inside nginx container
docker compose exec nginx sh
netstat -an | grep ESTABLISHED
```

## Updating Configuration

### Update Nginx Config
```bash
# Edit config
nano nginx/nginx.conf

# Apply changes (production)
docker compose --profile production restart nginx
```

### Update Backend
```bash
# Rebuild and restart
docker compose build backend
docker compose up -d backend
```

## Contact & Support

For issues related to:
- **Backend API**: Check [backend/src/server.js](backend/src/server.js)
- **Nginx routing**: Check [nginx/nginx.conf](nginx/nginx.conf)
- **Docker setup**: Check [docker-compose.yml](docker-compose.yml)
