import { RoiComponent, RoiProjectRow } from '../api/client';
import { fmtSignedUsd, fmtUsd } from '../lib/format';

/**
 * The ROI model as a picture: which inputs are measured by this portal, which are configured
 * assumptions, how they combine, and what the page refused to compute for the selected project.
 * Inline SVG so it follows the theme tokens and its text stays selectable and readable by AT.
 */

type Tag = 'measured' | 'assumed' | 'derived';
const TAG_COLOR: Record<Tag, string> = {
  measured: 'var(--accent-blue)', assumed: 'var(--warning)', derived: 'var(--primary-fg, var(--primary))',
};
const TAG_TEXT: Record<Tag, string> = { measured: 'MEASURED', assumed: 'ASSUMED', derived: 'DERIVED' };

function Box({ x, y, w, h, title, value, sub, tag, refused, dashed }: {
  x: number; y: number; w: number; h: number; title: string; value?: string; sub?: string;
  tag?: Tag; refused?: string; dashed?: boolean;
}) {
  const compact = h < 50;
  const maxChars = Math.floor((w - 24) / 5.6);
  const clip = (s: string) => (s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s);
  const line2 = refused ? `not computed — ${refused}` : sub;
  return (
    <g opacity={refused ? 0.55 : 1}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill="var(--surface-2, #f8fafc)" stroke="var(--border)"
        strokeWidth={1} strokeDasharray={dashed ? '4 3' : undefined} />
      {tag && (
        <>
          <rect x={x + w - 70} y={y + 7} width={62} height={14} rx={7} fill={TAG_COLOR[tag]} opacity={0.18} />
          <text x={x + w - 39} y={y + 17} textAnchor="middle" fontSize={8.5} fontWeight={600} letterSpacing={0.4}
            fill={TAG_COLOR[tag]}>{TAG_TEXT[tag]}</text>
        </>
      )}
      {compact ? (
        <>
          <text x={x + 12} y={y + 16} fontSize={11.5} fontWeight={600} fill="var(--text)">{title}</text>
          {line2 && <text x={x + 12} y={y + 30} fontSize={10} fontStyle={refused ? 'italic' : undefined}
            fill={refused ? 'var(--danger)' : 'var(--text-dim)'}>{clip(line2)}</text>}
        </>
      ) : (
        <>
          <text x={x + 12} y={y + 20} fontSize={12} fontWeight={600} fill="var(--text)">{title}</text>
          {value && <text x={x + 12} y={y + 40} fontSize={15} fontWeight={700} fill="var(--text)">{value}</text>}
          {line2 && <text x={x + 12} y={y + (value ? 56 : 40)} fontSize={10.5} fontStyle={refused ? 'italic' : undefined}
            fill={refused ? 'var(--danger)' : 'var(--text-dim)'}>{clip(line2)}</text>}
        </>
      )}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return <path d={`M${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`} fill="none"
    stroke="var(--chart-axis, #cbd5e1)" strokeWidth={1.5} markerEnd="url(#roi-arrow)" />;
}

const num = (v: number | string | null | undefined, f: (n: number) => string, fallback = '—') =>
  typeof v === 'number' && Number.isFinite(v) ? f(v) : fallback;
const pct = (n: number) => `${n}%`;
const plain = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function refusalFor(row: RoiProjectRow | undefined, needle: string): string | undefined {
  const r = row?.roi.refusals.find((s) => s.toLowerCase().startsWith(needle));
  return r ? r.replace(/^[^:]*:\s*/, '').replace(/\.$/, '') : undefined;
}

function compValue(c: RoiComponent | undefined, refused?: string): string | undefined {
  if (!c || refused) return undefined;
  return fmtSignedUsd(c.valueUsd) + ' / yr';
}

export function RoiModelDiagram({ row }: { row?: RoiProjectRow }) {
  const roi = row?.roi;
  const ts = roi?.value.timeSaved, tp = roi?.value.throughput, sd = roi?.value.stabilityDelta;
  const ai = roi?.investment.aiSpend, tr = roi?.investment.training, jc = roi?.investment.jCurve;
  const fi = (c?: RoiComponent) => c?.formulaInputs ?? {};
  const rTp = refusalFor(row, 'throughput'), rSd = refusalFor(row, 'stability'), rRoi = refusalFor(row, 'roi');
  const bracket = roi?.uncertainty ?? { bracketLowPct: -19, bracketHighPct: 56 };

  const roiText = roi
    ? roi.roiPct != null && !rRoi ? `${roi.roiPct >= 0 ? '+' : ''}${roi.roiPct.toFixed(1)}%` : 'not computable'
    : 'ROI = (Value − Investment) ÷ Investment';
  const paybackText = roi?.paybackMonths != null ? `payback ${roi.paybackMonths.toFixed(1)} mo` : 'payback = Investment ÷ Value';
  const beText = roi?.breakEven.hoursPerMonth != null
    ? `break-even ${roi.breakEven.hoursPerMonth.toFixed(1)} h / mo${roi.breakEven.pctOfCapacity != null ? ` · ${roi.breakEven.pctOfCapacity.toFixed(1)}% of capacity` : ''}`
    : 'break-even = monthly spend ÷ loaded hourly cost';

  const title = row ? `ROI model for ${row.name}` : 'ROI model';
  return (
    <svg viewBox="0 0 960 470" width="100%" role="img" aria-labelledby="roi-model-title roi-model-desc"
      style={{ display: 'block', fontFamily: 'inherit', maxWidth: 1180 }}>
      <title id="roi-model-title">{title}</title>
      <desc id="roi-model-desc">
        Measured inputs (AI spend, delivery metrics) and configured assumptions combine into Value and
        Investment; ROI equals Value minus Investment divided by Investment. Components the page refused
        to compute are shown faded with the reason.
      </desc>
      <defs>
        <marker id="roi-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--chart-axis, #cbd5e1)" />
        </marker>
      </defs>

      {/* column headers */}
      <text x={20} y={22} fontSize={11} fontWeight={600} letterSpacing={0.8} fill="var(--text-dim)">INPUTS · MEASURED BY THIS PORTAL</text>
      <text x={340} y={22} fontSize={11} fontWeight={600} letterSpacing={0.8} fill="var(--text-dim)">INPUTS · ASSUMPTIONS (EDITABLE)</text>
      <text x={660} y={22} fontSize={11} fontWeight={600} letterSpacing={0.8} fill="var(--text-dim)">MODEL · DORA FIRST-YEAR AI ROI</text>

      {/* measured column */}
      <Box x={20} y={34} w={290} h={70} tag="measured" title="AI spend (inference profiles)"
        value={ai ? fmtUsd(ai.valueUsd) + ' / yr' : 'daily rollups × rate card'}
        sub={ai ? `${num(fi(ai).windowSpendUsd, fmtUsd)} in window × ${num(fi(ai).annualizationFactor, plain)}` : 'annualised from the 30/90-day window'} />
      <Box x={20} y={114} w={290} h={70} tag="measured" title="Delivery (DORA store)"
        value={tp ? `Δ ${num(fi(tp).deltaFeaturesPerYear, plain)} features / yr` : 'deployments · lead time'}
        sub="merged PRs, deployments, change fail rate, MTTR" />
      <Box x={20} y={194} w={290} h={56} tag="measured" title="Stability (DORA store)"
        sub="change fail rate × MTTR × deployments, vs pre-AI baseline" />

      {/* assumptions column */}
      <Box x={340} y={34} w={290} h={70} tag="assumed" dashed title="Team & labour cost"
        value={ts ? `${num(fi(ts).teamSize, plain)} × ${num(fi(ts).loadedCostPerYear, fmtUsd)} / yr` : 'teamSize × loadedCostPerYear'}
        sub="per project, org default, or code default" />
      <Box x={340} y={114} w={290} h={70} tag="assumed" dashed title="Net time saved %"
        value={ts ? num(fi(ts).netTimeSavedPct, pct) : 'no multiplier assumed'}
        sub={`evidence bracket ${bracket.bracketLowPct}% … +${bracket.bracketHighPct}% (3 RCTs) — resolved per project`} />
      <Box x={340} y={194} w={290} h={56} tag="assumed" dashed title="Revenue conventions"
        sub={tp ? `idea success ${num(fi(tp).ideaSuccessRate, plain)} · impact ${num(fi(tp).revenueImpactPerFeature, plain)} · base ${num(fi(tp).revenueBase, fmtUsd)}` : 'idea success 0.33 · revenue impact 0.01–1% · revenue base'} />
      <Box x={340} y={260} w={290} h={56} tag="assumed" dashed title="Training & adoption dip (one-time)"
        sub={tr || jc
          ? `${num(fi(tr).trainingCostPerUser, fmtUsd)} / user · ${fi(jc).include ? `${num(fi(jc).dropPct, pct)} slower for first ${num(fi(jc).months, plain)} mo` : 'dip off'} · DORA default`
          : 'training per user · team slower for the first months'} />

      {/* flow: measured → assumptions column (short stubs), assumptions → model */}
      <Arrow x1={310} y1={69} x2={340} y2={69} />
      <Arrow x1={310} y1={149} x2={340} y2={149} />
      <Arrow x1={310} y1={222} x2={340} y2={222} />
      <Arrow x1={630} y1={69} x2={660} y2={77} />
      <Arrow x1={630} y1={149} x2={660} y2={115} />
      <Arrow x1={630} y1={222} x2={660} y2={153} />
      <Arrow x1={630} y1={288} x2={660} y2={271} />
      <Arrow x1={800} y1={174} x2={800} y2={188} />

      {/* value */}
      <rect x={660} y={34} width={280} height={140} rx={10} fill="none" stroke="var(--border)" strokeWidth={1} />
      <text x={672} y={52} fontSize={11} fontWeight={600} fill="var(--text-dim)">VALUE / yr (signed)</text>
      <text x={928} y={52} fontSize={12} fontWeight={700} textAnchor="end" fill="var(--text)">{roi ? fmtSignedUsd(roi.value.totalUsd) : ''}</text>
      <Box x={672} y={60} w={256} h={34} tag="derived" title="Time saved" value={undefined} sub={compValue(ts) ?? 'team × cost × net time saved %'} />
      <Box x={672} y={98} w={256} h={34} tag="derived" title="Throughput" sub={compValue(tp, rTp) ?? 'Δfeatures × conventions × revenue base'} refused={rTp} />
      <Box x={672} y={136} w={256} h={34} tag="derived" title="Stability Δ" sub={compValue(sd, rSd) ?? 'baseline incident cost − current'} refused={rSd} />

      {/* investment */}
      <rect x={660} y={188} width={280} height={110} rx={10} fill="none" stroke="var(--border)" strokeWidth={1} />
      <text x={672} y={206} fontSize={11} fontWeight={600} fill="var(--text-dim)">INVESTMENT / yr</text>
      <text x={928} y={206} fontSize={12} fontWeight={700} textAnchor="end" fill="var(--text)">{roi ? fmtUsd(roi.investment.totalUsd) : ''}</text>
      <Box x={672} y={214} w={256} h={34} tag="measured" title="AI spend" sub={ai ? fmtUsd(ai.valueUsd) + ' / yr' : 'measured, annualised'} />
      <Box x={672} y={252} w={124} h={38} tag={undefined} title="Training" sub={tr ? fmtUsd(tr.valueUsd) : 'one-time'} />
      <Box x={804} y={252} w={124} h={38} tag={undefined} title="Adoption dip" sub={jc ? `${fmtUsd(jc.valueUsd)} · first year` : 'one-time'} />

      {/* result */}
      <Arrow x1={800} y1={298} x2={800} y2={312} />
      <rect x={660} y={312} width={280} height={96} rx={10} fill="var(--primary-weak)" stroke="var(--primary)" strokeWidth={1} opacity={rRoi ? 0.7 : 1} />
      <text x={672} y={332} fontSize={11} fontWeight={600} fill="var(--text-dim)">ROI = (Value − Investment) ÷ Investment</text>
      <text x={672} y={362} fontSize={22} fontWeight={700} fill="var(--text)">{roiText}</text>
      <text x={672} y={382} fontSize={10.5} fontStyle={rRoi ? 'italic' : undefined} fill={rRoi ? 'var(--danger)' : 'var(--text-dim)'}>
        {rRoi ? (rRoi.length > 46 ? rRoi.slice(0, 45) + '…' : rRoi) : paybackText}
      </text>
      <text x={672} y={398} fontSize={10.5} fill="var(--text-dim)">{beText.length > 48 ? beText.slice(0, 47) + '…' : beText}</text>

      {/* legend + provenance */}
      <g fontSize={10.5} fill="var(--text-dim)">
        <rect x={20} y={340} width={10} height={10} rx={2} fill="var(--accent-blue)" opacity={0.6} /><text x={36} y={349}>Measured — from this portal's telemetry (enforceable attribution, DORA store)</text>
        <rect x={20} y={360} width={10} height={10} rx={2} fill="var(--warning)" opacity={0.6} /><text x={36} y={369}>Assumed — configured per project; every default is editable and disclosed</text>
        <rect x={20} y={380} width={10} height={10} rx={2} fill="var(--danger)" opacity={0.5} /><text x={36} y={389}>Faded — refused: the page withholds a number rather than invent an input</text>
        <text x={20} y={404} fontSize={10}>Adoption dip ("J-curve" in DORA's model): the team is temporarily slower while learning the tool — output dips, then recovers. One-time cost, applies to the first year only; off by default, editable per project.</text>
        <text x={20} y={420} fontSize={10}>Model skeleton: DORA first-year AI ROI (dora.dev/ai/roi), formulas verified against the calculator source. Evidence bracket: Peng 2023 (+55.8%), Google 2024 (~+21%), METR 2025 (−19%).</text>
        <text x={20} y={436} fontSize={10}>Full method: docs/ROI_METHODOLOGY.md · "within bracket" means plausible, never proven.</text>
      </g>
    </svg>
  );
}
