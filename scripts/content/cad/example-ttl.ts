/**
 * F299.3 — the CAD chain in the Generated assets example, written FROM a part's receipt so the
 * graph cannot claim a dimension, tool or origin the build did not record.
 *
 *   spec entity (parameters as facts)  --made-from-->  part (a 3D model with its GLB and render)
 *
 * The part's origin is labeled "modelled from parameters": never "scanned", never "generated
 * from a picture" (kb:cad-creation, principle EXACT, NOT GUESSED).
 */
import type { CadReceipt } from './receipt';

const lit = (v: string | number) => JSON.stringify(String(v));
const pname = (k: string) => `p:param-${k.replace(/_/g, '-')}`;

export const cadSpecId = (r: CadReceipt) => `kb:gen-cad-${r.spec.name}-spec`;
export const cadPartId = (r: CadReceipt) => `kb:gen-cad-${r.spec.name}-part`;

export function cadTtl(receipts: CadReceipt[]): string {
  const out: string[] = [];
  for (const r of receipts) {
    const slug = r.spec.name;
    const dir = `/generated/cad-${slug}`;
    const p = r.spec.params;
    const dims = `${p.width_mm} x ${p.depth_mm} x ${p.height_mm} mm`;
    out.push(
      `${cadSpecId(r)} rdf:type ktype:Concept ;`,
      `    rdfs:label ${lit(`Part spec: ${slug}`)} ;`,
      `    rdfs:comment ${lit(`A part described as numbers, in millimetres. The solid below was built from exactly these and its measured bounding box (${dims}) was checked against them within 0.1 mm.`)} ;`,
      `    p:part-kind ${lit(r.spec.kind)} ;`,
      ...Object.keys(r.spec.params).sort().map((k) => `    ${pname(k)} ${lit(r.spec.params[k])} ;`),
      `    p:spec-sha256 ${lit(r.specSha256)} ;`,
      `    p:has ${cadPartId(r)} .`,
      '',
      `${cadPartId(r)} rdf:type ktype:Model3D ;`,
      `    rdfs:label ${lit(`Part: ${slug}`)} ;`,
      `    kmeta:glbModel ${lit(`${dir}/${r.files.glb?.name ?? 'part.glb'}`)} ;`,
      `    p:photo ${lit(`${dir}/${r.blender?.frames[0]?.name ?? 'turntable-0.png'}`)} ;`,
      `    p:made-from ${cadSpecId(r)} ;`,
      `    p:origin-label ${lit(r.origin)} ;`,
      `    p:generated-with ${lit(`build123d ${r.tools.build123d} (OpenCascade ${r.tools.ocp}) and ${r.tools.blender ?? 'Blender'}`)} ;`,
      `    p:volume-mm3 ${lit(r.volumeMm3.toFixed(1))} ;`,
      `    rdfs:comment ${lit(`Modelled from parameters: an exact solid, not a scan and not a picture-to-3D guess. STEP and STL files sit beside the GLB at ${dir}/.`)} ;`,
      `    p:generated-at ${lit(r.builtAt.slice(0, 10))} .`,
      '',
    );
  }
  return out.join('\n');
}
