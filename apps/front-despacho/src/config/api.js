// Vite inyecta estas variables en build time, no en runtime, así que el
// Dockerfile las recibe como ARG y el pipeline las pasa con --build-arg.
// En local sin nada seteado, cae a localhost.

export const API_DESPACHO_URL =
  import.meta.env.VITE_API_DESPACHO_URL || "http://localhost:8081";

export const API_VENTAS_URL =
  import.meta.env.VITE_API_VENTAS_URL || "http://localhost:8080";
