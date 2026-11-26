extends Node2D
var t := 0.0
func _process(delta):
	t += delta
	$Ring.material.set_shader_parameter("progress", clamp(t / 0.6, 0.0, 1.0))
