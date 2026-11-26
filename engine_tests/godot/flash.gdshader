shader_type canvas_item;
// Expanding soft ring driven by a 0..1 progress uniform.
uniform float progress : hint_range(0.0, 1.0) = 0.0;
uniform vec4 color : source_color = vec4(1.0, 0.7, 0.3, 1.0);
void fragment() {
	float d = distance(UV, vec2(0.5)) * 2.0;
	float r = progress;
	float ring = smoothstep(0.12, 0.0, abs(d - r)) * (1.0 - progress);
	COLOR = vec4(color.rgb, color.a * ring);
}
