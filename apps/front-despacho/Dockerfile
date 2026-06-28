# ---- Etapa 1: build ----
FROM node:20-alpine AS build
WORKDIR /app

# Las URLs de los backends se inyectan en build time (Vite las "hornea" en el JS final)
ARG VITE_API_DESPACHO_URL
ARG VITE_API_VENTAS_URL
ENV VITE_API_DESPACHO_URL=$VITE_API_DESPACHO_URL
ENV VITE_API_VENTAS_URL=$VITE_API_VENTAS_URL

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Etapa 2: runtime (nginx sirviendo estáticos) ----
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
