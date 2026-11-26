extends Node
# Saves every rendered frame with alpha. Run with --fixed-fps for deterministic timing.
@export var frames := 24
var i := 0
func _ready():
	DirAccess.make_dir_recursive_absolute(OS.get_user_data_dir())
	RenderingServer.frame_post_draw.connect(_grab)
func _grab():
	var img := get_viewport().get_texture().get_image()
	var out := OS.get_cmdline_user_args()[0] if OS.get_cmdline_user_args().size() > 0 else "/tmp/frames"
	DirAccess.make_dir_recursive_absolute(out)
	img.save_png("%s/f_%03d.png" % [out, i])
	i += 1
	if i >= frames:
		get_tree().quit()
