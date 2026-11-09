// shapeImages.js
// Maps each shape to its rendered preview image (src/assets/shapes/*.png).
// Used by the "Node əlavə et" sidebar so each draggable shape shows a real
// picture of the shape instead of a small CSS pill.
import pill from '../assets/shapes/pill.png';
import rectangle from '../assets/shapes/rectangle.png';
import romb from '../assets/shapes/romb.png';
import parallel from '../assets/shapes/parallel.png';
import altProses from '../assets/shapes/alt-proses.png';
import elDaxiletme from '../assets/shapes/el-daxiletme.png';
import sened from '../assets/shapes/sened.png';
import hazirliq from '../assets/shapes/hazirliq.png';
import gecikme from '../assets/shapes/gecikme.png';
import trapezoid from '../assets/shapes/trapezoid.png';
import triangledown from '../assets/shapes/triangledown.png';
import roundright from '../assets/shapes/roundright.png';

export const SHAPE_IMAGE = {
  pill,
  rect: rectangle,
  diamond: romb,
  parallelogram: parallel,
  subprocess: altProses,
  manualinput: elDaxiletme,
  document: sened,
  preparation: hazirliq,
  delay: gecikme,
  trapezoid,
  triangledown,
  roundright,
};

export function shapeImage(shape) {
  return SHAPE_IMAGE[shape] || SHAPE_IMAGE.rect;
}
