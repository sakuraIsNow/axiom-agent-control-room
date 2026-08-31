import { CatmullRomCurve3, Vector3 } from 'three';

export type RoutingNode = {
  id: string;
  position: [number, number, number];
  size: [number, number, number];
};

/** Collision-aware radius used by every runtime graph renderer. */
export const nodeRadius = (node: RoutingNode) => Math.max(...node.size) * 0.58 * 1.12 + 0.08;

export const curveLength = (points: Vector3[]) => points.slice(1).reduce(
  (length, point, index) => length + point.distanceTo(points[index]),
  0,
);

export const curveClearance = (points: Vector3[], obstacles: RoutingNode[], fromId: string, toId: string) => {
  let minimum = Number.POSITIVE_INFINITY;
  for (const point of points.slice(2, -2)) {
    for (const obstacle of obstacles) {
      if (obstacle.id === fromId || obstacle.id === toId) continue;
      minimum = Math.min(minimum, point.distanceTo(new Vector3(...obstacle.position)) - nodeRadius(obstacle) - 0.14);
    }
  }
  return minimum;
};

/** Build a curved edge with endpoint offsets and obstacle-aware bend selection. */
export const buildConnectionPoints = (
  from: RoutingNode,
  to: RoutingNode,
  edgeIndex: number,
  edgeCount: number,
  obstacles: RoutingNode[],
): Array<[number, number, number]> => {
  const start = new Vector3(...from.position);
  const end = new Vector3(...to.position);
  const direction = end.clone().sub(start);
  const distance = direction.length();
  if (distance < 0.01) return [from.position, to.position];

  const unit = direction.normalize();
  const startRadius = nodeRadius(from);
  const endRadius = nodeRadius(to);
  const available = Math.max(0.08, distance - 0.18);
  const radiusScale = Math.min(1, available / Math.max(startRadius + endRadius, 0.01));
  const startPoint = start.clone().addScaledVector(unit, startRadius * radiusScale);
  const endPoint = end.clone().addScaledVector(unit, -endRadius * radiusScale);
  const bendDirection = new Vector3(-unit.y, unit.x, 0);
  if (bendDirection.lengthSq() < 0.0001) bendDirection.set(1, 0, 0);
  bendDirection.normalize();
  const sign = edgeIndex % 2 === 0 ? 1 : -1;
  const baseBend = Math.min(0.62, Math.max(0.16, distance * 0.12))
    * (edgeCount > 1 ? sign * (1 + (edgeIndex % 3) * 0.2) : 0);
  const bendCandidates = edgeCount > 1 ? [baseBend, baseBend + 0.42, baseBend - 0.42] : [0, 0.28, -0.28];
  const depthCandidates = edgeCount > 1 ? [0, 0.3, -0.3, 0.52, -0.52] : [0, 0.26, -0.26];
  const candidates = bendCandidates.flatMap((bend) => depthCandidates.map((depth) => {
    const controlA = startPoint.clone().lerp(endPoint, 0.34)
      .addScaledVector(bendDirection, bend)
      .add(new Vector3(0, 0, depth));
    const controlB = startPoint.clone().lerp(endPoint, 0.66)
      .addScaledVector(bendDirection, bend)
      .add(new Vector3(0, 0, depth));
    const curve = new CatmullRomCurve3([startPoint, controlA, controlB, endPoint], false, 'centripetal');
    const points = curve.getPoints(22);
    const clearance = curveClearance(points, obstacles, from.id, to.id);
    const score = clearance * 8 - Math.abs(depth) * 0.06 - curveLength(points) * 0.008;
    return { points, score };
  }));
  const best = candidates.reduce((winner, candidate) => candidate.score > winner.score ? candidate : winner);
  return best.points.map((point) => [point.x, point.y, point.z]);
};
