services:
  postgres:
    image: postgres:16-alpine
    container_name: astrabi-postgres
    environment:
      POSTGRES_DB: astrabi
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d astrabi']
      interval: 5s
      timeout: 5s
      retries: 10

  api:
    build:
      context: .
      dockerfile: Dockerfile.api
    ports:
      - '4000:4000'
    environment:
      NODE_ENV: development
      PORT: 4000
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/astrabi
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - '3000:3000'
    environment:
      PORT: 3000
      API_BASE_URL: http://localhost:4000
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped

volumes:
  postgres_data:
