import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, ChromaticAberration, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Line, MeshTransmissionMaterial, Sparkles } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdditiveBlending, Color, Group, MathUtils, Mesh, Vector2, Vector3 } from 'three';
import type { AgentGraph, AgentPhase, TopologyAgent } from '../../types';
import { buildConnectionPoints } from '../../lib/curveRouting';
import { getUiTheme, type UiTheme } from '../../lib/uiTheme';
import { isRibbonActive, resolveAgentStateId } from '../../lib/agentStateMachine';

type Props = { phase: AgentPhase; agents: TopologyAgent[]; graph: AgentGraph | null; theme: UiTheme; onSelectAgent: (id: string) => void };
type SceneNode = { id: string; title: string; role: string; status: NonNullable<AgentGraph['nodes'][number]['status']>; position: [number, number, number]; size: [number, number, number]; color: string };

const activePhase = (phase: AgentPhase) => phase === 'routing' || phase === 'context' || phase === 'inference';

const makeNodes = (agents: TopologyAgent[], graph: AgentGraph | null, theme: ReturnType<typeof getUiTheme>): SceneNode[] => {
  const source = graph?.nodes.filter((node) => node.id !== 'orchestrator').map((node) => ({ id: node.id, title: node.title, role: node.role, status: node.status ?? 'queued' }))
    ?? agents.map((agent) => ({ id: agent.id, title: agent.label, role: agent.role, status: agent.status }));
  return source.slice(0, 16).map((node, index, visible) => {
    const angle = index / Math.max(visible.length, 1) * Math.PI * 2 - Math.PI / 2;
    const radius = visible.length > 8 ? 3.05 : 2.7;
    return { ...node, position: [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.72, -0.18 + index % 3 * 0.18], size: [0.34, 0.34, 0.34], color: theme.roleColors[node.role] ?? theme.scene.signal };
  });
};

function Core({ phase, color, transmission }: { phase: AgentPhase; color: string; transmission: boolean }) {
  const mesh = useRef<Mesh>(null);
  const active = activePhase(phase);
  useFrame((state, delta) => {
    if (!mesh.current) return;
    const pulse = active ? Math.sin(state.clock.elapsedTime * 2.4) * 0.06 : 0;
    mesh.current.scale.setScalar(MathUtils.damp(mesh.current.scale.x, active ? 1.08 + pulse : 1, 4.5, delta));
    mesh.current.rotation.x += delta * (active ? 0.27 : 0.07);
    mesh.current.rotation.y -= delta * (active ? 0.43 : 0.11);
  });
  return <mesh ref={mesh}>
    <icosahedronGeometry args={[1.08, 4]} />
    {transmission ? <MeshTransmissionMaterial color={color} transmission={1} thickness={0.65} roughness={0.14} chromaticAberration={0.12} anisotropicBlur={0.08} samples={6} resolution={512} /> : <meshPhysicalMaterial color={color} emissive={new Color(color)} emissiveIntensity={active ? 1.1 : 0.32} metalness={0.9} roughness={0.22} clearcoat={0.75} />}
    <mesh scale={1.55}><icosahedronGeometry args={[1.08, 2]} /><meshBasicMaterial color={color} transparent opacity={active ? 0.08 : 0.035} blending={AdditiveBlending} depthWrite={false} wireframe /></mesh>
    <mesh rotation={[Math.PI / 2.4, 0.1, 0]}><torusGeometry args={[1.4, 0.018, 8, 96]} /><meshBasicMaterial color={color} transparent opacity={0.78} toneMapped={false} /></mesh>
  </mesh>;
}

function Agent({ node, signal, phase, onSelect }: { node: SceneNode; signal: string; phase: AgentPhase; onSelect: (id: string) => void }) {
  const active = node.status === 'running';
  const stateId = resolveAgentStateId(node.status, phase);
  const ribbonActive = isRibbonActive(stateId);
  const ribbon = useRef<Group>(null);
  const ribbonPoints = useMemo(() => Array.from({ length: 9 }, (_, index) => {
    const t = index / 8;
    return new Vector3(Math.sin(t * Math.PI * 2) * 0.62, (t - 0.5) * 1.9, Math.cos(t * Math.PI * 2) * 0.62);
  }), []);
  useFrame((state, delta) => {
    if (!ribbon.current) return;
    ribbon.current.rotation.y += delta * (active ? 1.8 : 0.5);
    ribbon.current.rotation.z = Math.sin(state.clock.elapsedTime * 1.4 + node.id.length) * 0.2;
  });
  return <group position={node.position} onClick={(event) => { event.stopPropagation(); onSelect(node.id); }}>
    <mesh scale={active ? 1.12 : 0.92}><icosahedronGeometry args={[0.36, 1]} /><meshPhysicalMaterial color={node.color} emissive={new Color(node.color)} emissiveIntensity={active ? 0.8 : 0.12} metalness={0.86} roughness={0.25} clearcoat={0.35} /></mesh>
    <mesh scale={active ? 1.4 : 1.12}><icosahedronGeometry args={[0.36, 1]} /><meshBasicMaterial color={active ? signal : node.color} wireframe transparent opacity={active ? 0.75 : 0.18} toneMapped={false} /></mesh>
    {active && <pointLight color={node.color} intensity={1.6} distance={3} />}
    {ribbonActive && <group ref={ribbon}><Line points={ribbonPoints} color={signal} transparent opacity={active ? 0.72 : 0.38} lineWidth={1.2} /></group>}
  </group>;
}

function Scene({ phase, agents, graph, theme, onSelectAgent }: Props) {
  const palette = getUiTheme(theme);
  const nodes = useMemo(() => makeNodes(agents, graph, palette), [agents, graph, palette]);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 700);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const query = window.matchMedia('(max-width: 700px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const active = activePhase(phase);
  const routingNodes = [{ id: 'core', position: [0, 0, 0] as [number, number, number], size: [1.2, 1.2, 1.2] as [number, number, number] }, ...nodes];
  const edges = graph?.edges?.length ? graph.edges.flatMap((edge) => {
    const from = nodes.find((node) => node.id === edge.from);
    const to = nodes.find((node) => node.id === edge.to);
    return from && to ? [{ from, to, active: to.status === 'running' }] : [];
  }) : nodes.map((node) => ({ from: routingNodes[0]!, to: node, active: node.status === 'running' }));
  return <>
    <color attach="background" args={[palette.scene.background]} />
    <fog attach="fog" args={[palette.scene.fog, 7, 14]} />
    <ambientLight intensity={0.36} color={palette.scene.ambient} />
    <directionalLight position={[4, 5, 5]} intensity={1.1} color={palette.scene.keyLight} />
    <pointLight position={[-4, 1, 2]} intensity={2.7} color={palette.scene.signal} distance={9} />
    <group rotation={[-0.04, 0, 0]}>
      {edges.map((edge, index) => { const points = buildConnectionPoints(edge.from, edge.to, index, edges.length, routingNodes); return <line key={`${edge.from.id}-${edge.to.id}`}><bufferGeometry attach="geometry" onUpdate={(geometry) => geometry.setFromPoints(points.map((point) => new Vector3(...point)))} /><lineBasicMaterial color={edge.active ? palette.scene.signal : palette.scene.idle} transparent opacity={edge.active ? 0.82 : 0.3} /></line>; })}
      <Core phase={phase} color={palette.scene.warm} transmission={!mobile} />
      {nodes.map((node) => <Agent key={node.id} node={node} phase={phase} signal={palette.scene.signal} onSelect={onSelectAgent} />)}
      <Sparkles count={mobile ? 70 : active ? 240 : 120} scale={[9, 6, 5]} size={mobile ? 1.4 : 2.1} speed={active ? 0.52 : 0.14} color={palette.scene.signal} opacity={active ? 0.62 : 0.24} />
      <gridHelper args={[18, 22, palette.scene.grid, palette.scene.gridSecondary]} position={[0, -2.5, -0.4]} />
    </group>
    <EffectComposer multisampling={0}>
      <Bloom intensity={active ? 0.72 : 0.28} luminanceThreshold={0.72} mipmapBlur />
      <ChromaticAberration offset={new Vector2(0.0005, 0.0005)} />
      <Vignette eskil={false} offset={0.24} darkness={0.72} />
    </EffectComposer>
  </>;
}

export function CinematicCore(props: Props) {
  return <div className="shell-core-canvas" aria-label="动态自主智能体核心"><Canvas camera={{ position: [0, 0.75, 8.2], fov: 42 }} dpr={[1, 1.35]} gl={{ antialias: true, powerPreference: 'high-performance' }}><Scene {...props} /></Canvas><div className={`shell-core-status ${activePhase(props.phase) ? 'active' : ''}`}><span />{activePhase(props.phase) ? '核心运行中' : '核心待命'}</div></div>;
}
