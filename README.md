# Innovatech Chile — EP3 DevOps: Orquestación en EKS + CI/CD

## 1. Arquitectura

```
                         Internet
                            │
                     ┌──────▼───────┐
                     │  ALB (Ingress)│
                     └───┬───────┬───┘
                         │       │
           ┌─────────────▼─┐   ┌─▼─────────────────┐
           │ front-despacho │   │  /api/v1/*         │
           │ (React+Nginx)  │   │  routing por path   │
           └────────────────┘   └──┬──────────────┬──┘
                                    │              │
                          ┌─────────▼───┐  ┌───────▼──────┐
                          │ despacho-back│  │ ventas-back  │
                          │ (SpringBoot) │  │ (SpringBoot) │
                          └──────┬───────┘  └──────┬───────┘
                                 │                 │
                                 └────────┬────────┘
                                          ▼
                                   RDS MySQL (privado)
```

- **Clúster:** Amazon EKS (`innovatech-cluster`), 1 managed node group con 2-4 nodos `t3.medium` (autoscaling vía HPA + Cluster Autoscaler si se agrega).
- **Namespace dedicado:** `innovatech`, para aislar el proyecto de otros recursos del clúster.
- **Networking:** VPC default de la cuenta del Learner Lab, subredes públicas para los nodos (simplicidad), Security Groups gestionados automáticamente por EKS para el tráfico nodo↔control plane y ALB↔nodos.
- **Roles IAM:** se usa `LabRole` (el rol pre-creado por AWS Academy) tanto para el control plane de EKS como para los nodos, porque el Learner Lab no permite crear roles IAM nuevos. Ver `infra/eksctl-cluster.yaml`.
- **Comunicación interna:** front → back y back → back vía DNS interno de Kubernetes (`Service` de tipo `ClusterIP`, ej. `http://despacho-back:8081`), no se expone IP pública para los backends.
- **Balanceo:** AWS Load Balancer Controller + `Ingress` (ALB real) enruta `/` al frontend y `/api/v1/despachos`, `/api/v1/ventas` a cada backend por path. Plan B si el controller no se puede instalar por permisos: `Service type=LoadBalancer` (NLB nativo, ver `k8s/front-service-loadbalancer.example.yaml`).
- **Autoscaling:** HPA por servicio, umbral 60% CPU (justificación en `k8s/hpa.yaml`), min 2 / max 6 réplicas en los backends.
- **CI/CD:** GitHub Actions (`.github/workflows/deploy.yml`) — build → push a ECR → deploy a EKS en cada push a `main`.
- **Secrets:** credenciales de BD viven en un `Secret` de Kubernetes (`db-credentials`), nunca en el código ni en los manifiestos versionados. Credenciales de AWS para el pipeline viven en GitHub Secrets.

---

## 2. Guía de despliegue paso a paso

### Paso 0 — Prerrequisitos
- Cuenta AWS Academy Learner Lab activa (iniciar el lab y dejarlo corriendo durante todo el trabajo).
- Instalar localmente: AWS CLI, `eksctl`, `kubectl`, Docker, Helm.
- Configurar AWS CLI con las credenciales temporales del Learner Lab (panel "AWS Details" → "AWS CLI" → copiar a `~/.aws/credentials`). **Estas credenciales expiran cuando el lab se reinicia** — hay que repetir este paso (y actualizar los secrets de GitHub) cada sesión.

### Paso 1 — Probar todo en local primero
```bash
docker compose up --build
```
Verifica que `front-despacho` (puerto 5173), `despacho-back` (8081) y `ventas-back` (8080) levanten y se comuniquen, antes de tocar AWS. Esto ahorra muchísimo tiempo de debugging en la nube.

### Paso 2 — Crear los repositorios en ECR
```bash
aws ecr create-repository --repository-name innovatech-despacho --region us-east-1
aws ecr create-repository --repository-name innovatech-ventas   --region us-east-1
aws ecr create-repository --repository-name innovatech-front    --region us-east-1
```

### Paso 3 — Crear el clúster EKS ⚠️ (probar esto primero, es el mayor riesgo)
1. Edita `infra/eksctl-cluster.yaml` y reemplaza `<ACCOUNT_ID>` por tu Account ID (panel "AWS Details" del Learner Lab).
2. Crea el clúster:
   ```bash
   eksctl create cluster -f infra/eksctl-cluster.yaml
   ```
   Tarda 15-20 min. **Si esto falla con un error de permisos IAM**, es la señal de que el Learner Lab no permite ni siquiera usar `LabRole` de esta forma — en ese caso, avísame y migramos la arquitectura a ECS Fargate, que es más simple en cuanto a IAM.
3. Verifica acceso:
   ```bash
   kubectl get nodes
   ```

### Paso 4 — RDS (la base de datos)
Crea una instancia RDS MySQL (puede ser desde la consola, `db.t3.micro`, en la misma VPC que el clúster). Anota el endpoint.

### Paso 5 — Crear el Secret de la base de datos
```bash
kubectl create namespace innovatech
kubectl create secret generic db-credentials -n innovatech \
  --from-literal=DB_ENDPOINT=<endpoint-de-tu-RDS> \
  --from-literal=DB_PORT=3306 \
  --from-literal=DB_NAME=innovatech \
  --from-literal=DB_USERNAME=admin \
  --from-literal=DB_PASSWORD=<tu-password>
```

### Paso 6 — metrics-server (necesario para que el HPA funcione)
EKS no lo trae instalado por defecto:
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

### Paso 7 — AWS Load Balancer Controller (para el Ingress/ALB)
⚠️ La instalación estándar usa IRSA (IAM Role for Service Account), que requiere crear una IAM Policy nueva — **normalmente bloqueado en el Learner Lab**. Workaround: omitir la creación de la policy/role y dejar que el controller use los permisos del nodo (`LabRole`) directamente:
```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=innovatech-cluster \
  --set serviceAccount.create=true
```
Si esto falla por permisos, usa el Plan B (`k8s/front-service-loadbalancer.example.yaml`) en vez del Ingress.

### Paso 8 — Configurar los GitHub Secrets del repo
En Settings → Secrets and variables → Actions, crea:
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (del Learner Lab — **actualizar cada vez que se reinicia el lab**)
- `VITE_API_DESPACHO_URL`, `VITE_API_VENTAS_URL` (la URL pública del ALB una vez creado, ej. `http://<alb-dns>/api/v1/despachos`)

### Paso 9 — Primer deploy
```bash
git push origin main
```
Esto dispara el workflow. Revisa la pestaña **Actions** de GitHub para ver build → push → deploy en vivo.

### Paso 10 — Validar
```bash
kubectl get pods -n innovatech
kubectl get ingress -n innovatech     # acá sale la URL pública del ALB
kubectl logs -n innovatech deployment/despacho-back
```

### Paso 11 — Simular carga y mostrar autoscaling
```bash
kubectl run carga --image=busybox -n innovatech --restart=Never -- /bin/sh -c \
  "while true; do wget -q -O- http://despacho-back:8081/api/v1/despachos; done"
kubectl get hpa -n innovatech --watch
```
Toma captura cuando veas que `REPLICAS` sube de 2 a más. Luego elimina el pod de carga: `kubectl delete pod carga -n innovatech`.

---

## 3. Problemas encontrados y cómo se resolvieron
*(completar con su experiencia real — el contenido de abajo son los riesgos ya identificados de antemano, agreguen lo que les pase a ustedes)*

| Problema | Causa | Solución |
|---|---|---|
| URLs hardcodeadas (`192.168.x.x`) en el frontend | Quedaron de un despliegue local anterior | Se migraron a variables de entorno de Vite inyectadas en build-time (`src/config/api.js`) |
| `eksctl` no puede crear roles IAM | Restricción de permisos de AWS Academy Learner Lab | Se usa `LabRole` explícitamente en `iam.serviceRoleARN` / `iam.instanceRoleARN` |
| Credenciales de AWS expiran | Learner Lab entrega credenciales STS temporales | Hay que rotar los 3 GitHub Secrets de AWS cada sesión de lab |
| *(agregar los suyos)* | | |

## 4. Métricas del pipeline
*(completar con datos reales de la pestaña Actions de GitHub: tiempo total del workflow, tiempo de build de cada imagen, tasa de éxito/fallo en los intentos, tiempo de rollout en k8s)*
