import { Line, OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { useEffect, useMemo, useRef } from 'react';
import { CatmullRomCurve3, Color, Group, MathUtils, Mesh, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { AgentPhase, TopologyAgent } from '../types';
import { getUiTheme, type UiTheme } from '../lib/uiTheme';
import { buildConnectionPoints } from '../lib/curveRouting';

type AgentSceneProps = {
  phase: AgentPhase;
  resetKey: number;
  agents: TopologyAgent[];
  theme: UiTheme;
  selectedAgentId?: string | null;
  onSelectAgent?: (agentId: string) => void;
  reducedMotion?: boolean;
};

type NodeDefinition = {
  id: string;
  position: [number, number, number];
  color: string;
  size: [number, number, number];
  status: TopologyAgent['status'];
  parentIds: string[];
  selected: boolean;
};

type ConnectionDefinition = {
  id: string;
  points: Array<[number, number, number]>;
  active: boolean;
  color: string;
  delay: number;
};

const buildNodes = (
  agents: TopologyAgent[],
  phase: AgentPhase,
  roleColors: Record<string, string>,
  idleColor: string,
  signalColor: string,
  selectedAgentId?: string | null,
): NodeDefinition[] => {
  const agentByStep = new Map(agents.filter((agent) => agent.stepId).map((agent) => [agent.stepId!, agent.id]));
  const runtimeActive = phase === 'routing' || phase === 'context' || phase === 'inference';
  const root: NodeDefinition = {
    id: 'orchestrator',
    position: [0, 0, 0],
    color: roleColors.orchestrator ?? signalColor,
    size: [1.2, 1.2, 1.2],
    status: phase === 'error'
      ? 'failed'
      : runtimeActive || agents.some((agent) => agent.status === 'running')
        ? 'running'
        : phase === 'complete' || agents.length > 0
          ? 'completed'
          : 'queued',
    parentIds: [],
    selected: selectedAgentId === 'orchestrator',
  };
  return [root, ...agents.slice(-10).map((agent, index, visible) => {
    const angle = (index / Math.max(visible.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = visible.length > 6 ? 3.25 : 2.95;
    const tier = index % 2 === 0 ? 0.32 : -0.32;
    return {
      id: agent.id,
      // A wider elliptical orbit keeps the active root and the lowest worker
      // apart even while their shells are pulsing during an answer.
      position: [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.82 + tier, -0.35 - (index % 3) * 0.16],
      color: agent.status === 'failed' ? '#d8787d' : roleColors[agent.role] ?? signalColor,
      size: agent.role === 'reviewer' ? [0.88, 0.42, 0.88] : [0.72, 0.72, 0.72],
      status: agent.status,
      parentIds: agent.dependsOn?.length
        ? agent.dependsOn.map((dependency) => agentByStep.get(dependency) ?? dependency)
        : [agent.parentId ?? 'orchestrator'],
      selected: selectedAgentId === agent.id,
    } satisfies NodeDefinition;
  })];
};

function RuntimeNode({ node, idleColor, errorColor, onSelect }: { node: NodeDefinition; idleColor: string; errorColor: string; onSelect?: (agentId: string) => void }) {
  const group = useRef<Group>(null);
  const core = useRef<Mesh>(null);
  const wire = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const active = node.status === 'running';
  const failed = node.status === 'failed';
  const completed = node.status === 'completed';
  const color = failed ? errorColor : node.color;
  const radius = Math.max(node.size[0], node.size[1], node.size[2]) * 0.58;

  useFrame((state, delta) => {
    if (!group.current || !core.current) return;
    const pulse = active ? Math.sin(state.clock.elapsedTime * 3.2 + node.position[0]) * 0.045 : 0;
    const targetScale = node.selected ? 1.2 : active ? 1.13 + pulse : completed ? 1 : 0.88;
    const nextScale = MathUtils.damp(group.current.scale.x, targetScale, 5, delta);
    group.current.scale.setScalar(nextScale);
    core.current.rotation.y += delta * (active ? 0.52 : 0.08);
    core.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.4 + node.position[0]) * 0.06;
    if (wire.current) {
      wire.current.rotation.x += delta * (active ? 0.24 : 0.035);
      wire.current.rotation.y -= delta * (active ? 0.34 : 0.045);
    }
    if (ring.current) ring.current.rotation.z += delta * (active ? 0.58 : 0.06);
  });

  return (
    <group ref={group} position={node.position} onClick={(event) => { event.stopPropagation(); onSelect?.(node.id); }}>
      <mesh ref={core} castShadow>
        <icosahedronGeometry args={[radius, 1]} />
        <meshPhysicalMaterial
          color={active || completed || failed ? color : idleColor}
          emissive={new Color(color)}
          emissiveIntensity={node.selected ? 1.1 : active ? 0.72 : completed ? 0.16 : failed ? 0.45 : 0.02}
          metalness={0.84}
          roughness={0.26}
          clearcoat={0.42}
          clearcoatRoughness={0.2}
        />
      </mesh>
      <mesh ref={wire} rotation={[0, Math.PI / 4, 0]} scale={active ? 1.34 : 1.14}>
        <icosahedronGeometry args={[radius, 1]} />
        <meshBasicMaterial color={color} transparent opacity={active ? 0.62 : 0.1} toneMapped={false} wireframe />
      </mesh>
      <mesh ref={ring} rotation={[Math.PI / 2.5, 0.2, 0]}>
        <torusGeometry args={[radius * 1.12, Math.max(0.012, radius * 0.025), 8, 36]} />
        <meshBasicMaterial color={color} transparent opacity={active ? 0.92 : 0.18} toneMapped={false} />
      </mesh>
      {active && (
        <mesh scale={1.58}>
          <icosahedronGeometry args={[radius, 2]} />
          <meshBasicMaterial color={color} transparent opacity={0.055} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function SignalPath({ points, active, color, idleColor, delay }: {
  points: Array<[number, number, number]>;
  active: boolean;
  color: string;
  idleColor: string;
  delay: number;
}) {
  const signal = useRef<Mesh>(null);
  const curve = useMemo(
    () => new CatmullRomCurve3(points.map((point) => new Vector3(...point)), false, 'centripetal'),
    [points],
  );

  useFrame((state) => {
    if (!signal.current) return;
    const progress = ((state.clock.elapsedTime * 0.38 + delay) % 1 + 1) % 1;
    signal.current.position.copy(curve.getPointAt(progress));
    signal.current.visible = active;
  });

  return (
    <>
      <Line
        points={points}
        color={active ? color : idleColor}
        lineWidth={active ? 1.55 : 0.68}
        transparent
        opacity={active ? 0.9 : 0.38}
        depthTest
        depthWrite={false}
        renderOrder={-2}
      />
      <mesh ref={signal} visible={active} renderOrder={-1}>
        <sphereGeometry args={[0.048, 10, 10]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </>
  );
}

function CameraController({ resetKey, reducedMotion }: { resetKey: number; reducedMotion: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 1.1, 7.8);
    controls.current?.reset();
  }, [camera, resetKey]);

  return (
    <OrbitControls
      ref={controls}
      autoRotate={!reducedMotion}
      autoRotateSpeed={0.25}
      enableDamping
      enablePan={false}
      maxDistance={10}
      minDistance={5.5}
      maxPolarAngle={Math.PI * 0.7}
      minPolarAngle={Math.PI * 0.26}
    />
  );
}

function Topology({ phase, resetKey, agents, theme, selectedAgentId, onSelectAgent, reducedMotion = false }: AgentSceneProps) {
  const palette = getUiTheme(theme);
  const nodes = useMemo(
    () => buildNodes(agents, phase, palette.roleColors, palette.scene.idle, palette.scene.signal, selectedAgentId),
    [agents, palette, phase, selectedAgentId],
  );
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const connections = useMemo<ConnectionDefinition[]>(() => nodes.slice(1).flatMap((node, nodeIndex) => {
    const parents = node.parentIds
      .map((parentId) => byId.get(parentId) ?? byId.get('orchestrator'))
      .filter((parent): parent is NodeDefinition => Boolean(parent));
    return parents.map((parent, edgeIndex) => ({
      id: `${parent.id}:${node.id}`,
      points: buildConnectionPoints(parent, node, edgeIndex + nodeIndex, parents.length + nodes.length, nodes),
      active: node.status === 'running',
      color: node.color,
      delay: (edgeIndex + nodeIndex) / Math.max(nodes.length, 1),
    }));
  }), [byId, nodes]);

  return (
    <>
      <color attach="background" args={[palette.scene.background]} />
      <fog attach="fog" args={[palette.scene.fog, 7.8, 13]} />
      <ambientLight intensity={0.5} color={palette.scene.ambient} />
      <directionalLight position={[4, 6, 4]} intensity={1.1} color={palette.scene.keyLight} />
      <pointLight position={[-4, 2, 2]} intensity={2.6} color={palette.scene.signal} distance={8} />
      <pointLight position={[4, -1, 2]} intensity={2.2} color={phase === 'error' ? palette.scene.error : palette.scene.warm} distance={8} />

      <group rotation={[-0.08, 0, 0]}>
        {connections.map((connection) => (
          <SignalPath
            key={connection.id}
            points={connection.points}
            active={connection.active}
            color={connection.color}
            idleColor={palette.scene.idle}
            delay={connection.delay}
          />
        ))}
        {nodes.map((node) => <RuntimeNode key={node.id} node={node} idleColor={palette.scene.idle} errorColor={palette.scene.error} onSelect={onSelectAgent} />)}
        <gridHelper args={[18, 24, palette.scene.grid, palette.scene.gridSecondary]} position={[0, -2.55, -0.5]} />
      </group>

      <EffectComposer multisampling={0}>
        <Bloom intensity={phase === 'routing' || phase === 'context' || phase === 'inference' ? 0.46 : 0.2} luminanceThreshold={0.82} mipmapBlur />
      </EffectComposer>
      <CameraController resetKey={resetKey} reducedMotion={reducedMotion} />
    </>
  );
}

export function AgentScene({ phase, resetKey, agents, theme, selectedAgentId, onSelectAgent }: AgentSceneProps) {
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  return (
    <div className="agent-scene">
      <Canvas
        aria-label="事件驱动的 Agent 运行拓扑"
        camera={{ position: [0, 1.1, 7.8], fov: 43 }}
        dpr={[1, 1.55]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        frameloop={reducedMotion ? 'demand' : 'always'}
        shadows
      >
        <Topology phase={phase} resetKey={resetKey} agents={agents} theme={theme} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} reducedMotion={reducedMotion} />
      </Canvas>
      <p className="sr-only">
        根据持久化任务和子 Agent 运行事件生成的实时拓扑。
      </p>
    </div>
  );
}
