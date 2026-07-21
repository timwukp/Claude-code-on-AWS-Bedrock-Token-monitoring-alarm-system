## Bug-Fix Agent — 7/8 finding(s) patched

- **F09** (CRITICAL) → patched `frontend/src/pages/GovernancePage.tsx`

```diff
--- a/frontend/src/pages/GovernancePage.tsx
+++ b/frontend/src/pages/GovernancePage.tsx
@@ -1,5 +1,5 @@
 import { useEffect, useState } from 'react';
 import { api } from '../api/client';
 import { Kpi, Panel } from '../components/Layout';
 import { fmtUsd } from '../lib/format';
 
@@ -13,9 +13,16 @@ export function GovernancePage() {
   const [loading, setLoading] = useState(true);
 
   useEffect(() => {
-    api.governance().then(setData).catch((e) => setError(String(e))).finally(() => setLoading(false));
+    Promise.all([api.governance(), api.costs()])
+      .then(([govData, costsData]) => {
+        const actualUsd = costsData?.estimatedSpend ?? govData?.budget?.actualUsd ?? 0;
+        const limitUsd = govData?.budget?.limitUsd;
+        const actualPct = limitUsd ? Math.round((actualUsd / limitUsd) * 100) : govData?.budget?.actualPct;
+        setData({
+          ...govData,
+          budget: { ...govData?.budget, actualUsd, actualPct },
+        });
+      })
+      .catch((e) => setError(String(e)))
+      .finally(() => setLoading(false));
   }, []);
 
   if (loading) return <div className="empty"><span className="spinner" /></div>;
```

- **F02** (HIGH) → patched `backend/lambdas/api/usage.ts`

```diff
--- a/backend/lambdas/api/usage.ts
+++ b/backend/lambdas/api/usage.ts
@@ -36,6 +36,7 @@ export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayPr
         inputTokens: i.inputTokens ?? 0,
         outputTokens: i.outputTokens ?? 0,
         invocations: i.invocations ?? 0,
+        clientErrors: i.clientErrors ?? 0,
       })),
     });
   } catch (err) {
```

- **F03** — agent produced no applicable diff.

- **F04** (HIGH) → patched `frontend/src/pages/ProjectsPage.tsx`

```diff
--- a/frontend/src/pages/ProjectsPage.tsx
+++ b/frontend/src/pages/ProjectsPage.tsx
@@ -12,7 +12,7 @@ export function ProjectsPage() {
   const [rows, setRows] = useState<any[]>([]);
-  const [source, setSource] = useState<'fast' | 'full'>('fast');
+  const [source, setSource] = useState<'fast' | 'full'>('full');
   const [servedFrom, setServedFrom] = useState<string>('');
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(true);
```

- **F05** (HIGH) → patched `backend/lambdas/api/costs.ts`

```diff
--- a/backend/lambdas/api/costs.ts
+++ b/backend/lambdas/api/costs.ts
@@ -28,10 +28,17 @@ export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayPr
 
-    const items: TokenCounts[] = (res.Items ?? []).map((i) => ({
-      modelId: String(i.modelId ?? ''),
-      inputTokens: Number(i.inputTokens ?? 0),
-      outputTokens: Number(i.outputTokens ?? 0),
-      cacheReadTokens: Number(i.cacheReadTokens ?? 0),
-    }));
+    const merged = new Map<string, TokenCounts>();
+    for (const i of res.Items ?? []) {
+      const modelId = String(i.modelId ?? '');
+      const existing = merged.get(modelId);
+      if (existing) {
+        existing.inputTokens += Number(i.inputTokens ?? 0);
+        existing.outputTokens += Number(i.outputTokens ?? 0);
+        existing.cacheReadTokens += Number(i.cacheReadTokens ?? 0);
+      } else {
+        merged.set(modelId, {
+          modelId,
+          inputTokens: Number(i.inputTokens ?? 0),
+          outputTokens: Number(i.outputTokens ?? 0),
+          cacheReadTokens: Number(i.cacheReadTokens ?? 0),
+        });
+      }
+    }
+    const items: TokenCounts[] = Array.from(merged.values());
 
     const summary = summarizeCosts(items);
```

- **F01** (HIGH) → patched `backend/lambdas/api/usage.ts`

```diff
--- a/backend/lambdas/api/usage.ts
+++ b/backend/lambdas/api/usage.ts
@@ -49,6 +49,6 @@ export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayP
 
 function defaultFrom(): string {
   const d = new Date();
-  d.setDate(d.getDate() - 7);
+  d.setTime(d.getTime() - 7 * 24 * 60 * 60 * 1000);
   return d.toISOString();
 }
```

- **F06** (MEDIUM) → patched `backend/lambdas/api/costs.ts`

```diff
--- a/backend/lambdas/api/costs.ts
+++ b/backend/lambdas/api/costs.ts
@@ -28,7 +28,8 @@ export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayPr
 
     const merged = new Map<string, TokenCounts>();
     for (const i of res.Items ?? []) {
-      const modelId = String(i.modelId ?? '');
+      const rawModelId = String(i.modelId ?? '');
+      const modelId = rawModelId.replace(/^(us|eu|ap)\./, '');
       const existing = merged.get(modelId);
       if (existing) {
         existing.inputTokens += Number(i.inputTokens ?? 0);
```

- **F07** (MEDIUM) → patched `backend/lambdas/api/projects.ts`

```diff
--- a/backend/lambdas/api/projects.ts
+++ b/backend/lambdas/api/projects.ts
@@ -44,7 +44,6 @@ export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayPr
       FROM bedrock_invocation_logs l
       LEFT JOIN project_mapping m
         ON l.requestMetadata['project_id'] = m.project_id
       WHERE COALESCE(l.requestMetadata['tenant'], l.identity.arn) = '${sanitize(tenantId)}'
-        AND l.requestMetadata['project_id'] IS NOT NULL
       GROUP BY 1, 2
       ORDER BY tokens DESC
       LIMIT 100`;
```
