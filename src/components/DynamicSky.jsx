import React, { useRef, useMemo, useImperativeHandle, forwardRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const vertexShader = `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const fragmentShader = `
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 skyTopColor;
uniform vec3 skyBottomColor;
uniform float sunIntensity;
varying vec3 vWorldPosition;

void main() {
  vec3 direction = normalize(vWorldPosition);
  float y = direction.y;
  float t = max(0.0, y);
  vec3 skyColor = mix(skyBottomColor, skyTopColor, pow(t, 0.4));
  float sunDot = max(0.0, dot(direction, normalize(sunDirection)));
  float sunDisc = smoothstep(0.997, 0.999, sunDot) * sunIntensity;
  vec3 sunGlow = vec3(1.0, 0.95, 0.8) * sunDisc * 2.0;
  float sunHalo = pow(sunDot, 8.0) * sunIntensity * 0.5;
  vec3 haloColor = sunColor * sunHalo;
  float horizonGlow = pow(1.0 - abs(y), 4.0) * 0.3;
  vec3 horizonColor = sunColor * horizonGlow * sunIntensity;
  vec3 finalColor = skyColor + sunGlow + haloColor + horizonColor;
  gl_FragColor = vec4(finalColor, 1.0);
}
`

const DynamicSky = forwardRef((_props, ref) => {
  const meshRef = useRef()
  useImperativeHandle(ref, () => meshRef.current, [])

  const uniforms = useMemo(() => ({
    sunDirection: { value: new THREE.Vector3(0, 1, 0.3) },
    sunColor: { value: new THREE.Color('#ffffee') },
    skyTopColor: { value: new THREE.Color('#4488cc') },
    skyBottomColor: { value: new THREE.Color('#88bbee') },
    sunIntensity: { value: 1.2 },
  }), [])

  // Follow the camera so the skybox stays centered and doesn't appear to move
  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.position.copy(state.camera.position)
    }
  })

  return (
    <mesh ref={meshRef} scale={[-1, 1, 1]}>
      <sphereGeometry args={[2000, 32, 32]} />
      <shaderMaterial uniforms={uniforms} vertexShader={vertexShader} fragmentShader={fragmentShader} side={THREE.BackSide} depthWrite={false} />
    </mesh>
  )
})

DynamicSky.displayName = 'DynamicSky'
export default DynamicSky
