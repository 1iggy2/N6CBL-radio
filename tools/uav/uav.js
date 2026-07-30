/* /tools/uav/ — fixed-wing UAV design lab.
 *
 * Architecture (kept deliberately framework-shaped so the tool can grow):
 *   PARAMS   — registry of every design input: bounds, units, defaults, groups,
 *              and a physics explainer. The form, the design file, the Monte
 *              Carlo sampler, the sensitivity table, and the parameter
 *              reference all read this registry; adding a parameter here wires
 *              it in everywhere.
 *   AIRFOILS — 2-D section database (RC-Reynolds polar summaries + shape params).
 *   PRESETS  — COTS component archetypes (airframes, motors, batteries) that
 *              write into PARAMS keys; specs are approximate class values.
 *   derive() — pure function: design → derived quantities. No DOM access, so
 *              search and sensitivity code can call it tens of thousands of times.
 *   METRICS  — registry of derived outputs: labels, units, formatting. Constraint
 *              and objective pickers are generated from PARAMS + METRICS, which is
 *              what makes "any parameter can be a constraint" hold.
 *   Views    — readouts, design checks, SVG 3-view, airfoil section, performance
 *              charts, sensitivity table, Monte Carlo scatter. All views
 *              re-render from one state.
 *   Design file — versioned JSON (n6cbl.uav-design/1) download/upload for
 *              save/resume; parameters only, derived values are recomputed.
 */
(function () {
  'use strict';

  var G = 9.80665;          // m/s^2
  var MU_AIR = 1.81e-5;     // Pa*s, dynamic viscosity of air at ~15 C
  var CELL_V = 3.7;         // nominal LiPo cell voltage
  var SCHEMA = 'n6cbl.uav-design/1';
  var STORE_KEY = 'n6cbl.uav.working';  // localStorage autosave slot (device-local, never sent anywhere)
  var DASH = '—';

  /* ── airfoil database ─────────────────────────────────────────────────
   * 2-D section values summarized from published low-Reynolds polars
   * (UIUC LSATs / Airfoil Tools, Re ≈ 100k–400k). cla is per radian.
   * camber/camberPos/thickness (% chord) drive the drawn section, which is a
   * NACA-4-digit-style reconstruction — exact for NACA foils, an approximation
   * for the rest (labeled as such on the figure).
   */
  var AIRFOILS = {
    clarky:   { label: 'Clark Y',        camber: 3.4, camberPos: 42, thickness: 11.7, cl0: 0.38, cla: 6.0, clmax: 1.35, cd0: 0.0100, cm: -0.085, use: 'classic trainer / general sport' },
    naca2412: { label: 'NACA 2412',      camber: 2.0, camberPos: 40, thickness: 12.0, cl0: 0.25, cla: 6.1, clmax: 1.25, cd0: 0.0090, cm: -0.050, use: 'general purpose, docile stall' },
    naca4412: { label: 'NACA 4412',      camber: 4.0, camberPos: 40, thickness: 12.0, cl0: 0.45, cla: 6.0, clmax: 1.45, cd0: 0.0100, cm: -0.100, use: 'high lift, slow flyers / payload' },
    naca0012: { label: 'NACA 0012',      camber: 0.0, camberPos: 30, thickness: 12.0, cl0: 0.00, cla: 6.1, clmax: 1.10, cd0: 0.0080, cm:  0.000, use: 'symmetric — aerobats, tails' },
    sd7037:   { label: 'SD7037',         camber: 3.0, camberPos: 42, thickness:  9.2, cl0: 0.35, cla: 6.2, clmax: 1.30, cd0: 0.0080, cm: -0.070, use: 'sailplane workhorse' },
    e205:     { label: 'Eppler E205',    camber: 3.0, camberPos: 40, thickness: 10.5, cl0: 0.25, cla: 6.1, clmax: 1.15, cd0: 0.0080, cm: -0.050, use: 'sailplane, wide speed range' },
    ag35:     { label: 'AG35',           camber: 2.3, camberPos: 38, thickness:  8.7, cl0: 0.25, cla: 6.2, clmax: 1.10, cd0: 0.0070, cm: -0.060, use: 'F3-class glider, low drag' },
    mh32:     { label: 'MH32',           camber: 2.4, camberPos: 40, thickness:  8.7, cl0: 0.25, cla: 6.2, clmax: 1.15, cd0: 0.0070, cm: -0.060, use: 'fast glider / electric sport' },
    s1223:    { label: 'Selig S1223',    camber: 8.1, camberPos: 49, thickness: 12.1, cl0: 1.00, cla: 5.9, clmax: 2.10, cd0: 0.0150, cm: -0.250, use: 'max lift — heavy-payload lifters' },
    flat:     { label: 'Flat plate',     camber: 0.0, camberPos: 30, thickness:  3.0, cl0: 0.00, cla: 5.5, clmax: 0.80, cd0: 0.0200, cm:  0.000, use: 'foamboard / park flyer baseline' }
  };

  var TAIL_TYPES = {
    conventional: { label: 'Conventional' },
    ttail:        { label: 'T-tail' },
    vtail:        { label: 'V-tail' }
  };

  /* ── parameter registry ──────────────────────────────────────────────── */
  var PARAMS = [
    // wing + fuselage geometry
    { key: 'span',        group: 'geometry', label: 'Wing span',          unit: 'm',     def: 1.50,  min: 0.30,  max: 8.0,   step: 0.01,
      teach: 'Primary driver of induced drag through aspect ratio: at fixed weight and speed, induced drag scales with 1/b². More span means a flatter glide and slower roll response, and the structural bending moment at the root grows with it.' },
    { key: 'rootChord',   group: 'geometry', label: 'Root chord',         unit: 'm',     def: 0.24,  min: 0.05,  max: 2.0,   step: 0.005,
      teach: 'With span and taper this sets wing area, hence wing loading and stall speed. Bigger chord also raises the Reynolds number, which improves airfoil behavior at RC scale.' },
    { key: 'taper',       group: 'geometry', label: 'Taper ratio',        unit: 'tip/root', def: 0.70, min: 0.25, max: 1.0,  step: 0.01,
      teach: 'Tip chord over root chord. Moderate taper approaches the elliptical lift distribution (better span efficiency e), but small tips run low Reynolds numbers and stall first — the classic tip-stall trade.' },
    { key: 'sweepLE',     group: 'geometry', label: 'LE sweep',           unit: 'deg',   def: 0,     min: 0,     max: 35,    step: 0.5,
      teach: 'At model speeds sweep is not about compressibility: it moves the aerodynamic center aft and adds effective dihedral. Mostly a CG-range, stability, and styling decision.' },
    { key: 'dihedral',    group: 'geometry', label: 'Dihedral',           unit: 'deg',   def: 3,     min: 0,     max: 12,    step: 0.5,
      teach: 'Tilting the panels up gives roll stability: in a sideslip the low wing meets the air at higher effective angle of attack and rolls the aircraft level. Traded against roll agility — aerobats fly near zero.' },
    { key: 'fusLength',   group: 'geometry', label: 'Fuselage length',    unit: 'm',     def: 1.00,  min: 0.20,  max: 6.0,   step: 0.01,
      teach: 'Sets wetted area (skin-friction drag) and how far aft the tail can sit. A longer fuselage costs drag but buys tail arm, which buys stability per gram of tail.' },
    { key: 'fusDiameter', group: 'geometry', label: 'Fuselage diameter',  unit: 'm',     def: 0.09,  min: 0.02,  max: 1.00,  step: 0.005,
      teach: 'Drives fuselage wetted area and the internal volume available for battery and payload. Parasite drag grows roughly linearly with diameter at fixed length.' },
    { key: 'cgMac',       group: 'geometry', label: 'CG position',        unit: '% MAC', def: 30,    min: 10,    max: 45,    step: 0.5,
      teach: 'Where the mass balances along the mean chord. CG ahead of the neutral point = stable; the gap between them is the static margin. The single most important number to get right before a first flight.' },
    // tail geometry
    { key: 'tailType',    group: 'tail',     label: 'Tail configuration', unit: 'layout', def: 'conventional', options: TAIL_TYPES,
      teach: 'Conventional is easiest to build and trim. A T-tail lifts the stabilizer out of the wing downwash (modeled here as a reduced downwash derivative) at a structural cost. A V-tail merges both surfaces into two panels — less wetted area and parts, but requires ruddervator mixing and couples pitch/yaw.' },
    { key: 'tailArm',     group: 'tail',     label: 'Tail arm (c/4→c/4)', unit: 'm', def: 0.58, min: 0.15,  max: 5.0,   step: 0.01,
      teach: 'Lever arm from wing quarter-chord to tail quarter-chord. Tail effectiveness scales with arm × area, so a longer arm delivers the same stability with a smaller, lighter, lower-drag tail.' },
    { key: 'vh',          group: 'tail',     label: 'H-tail volume Vₕ', unit: '-',  def: 0.50,  min: 0.25,  max: 0.90,  step: 0.01,
      teach: 'Horizontal tail volume coefficient Vₕ = Sₕ·Lₜ/(S·MAC) — the classic similarity number for pitch stability. Trainers run ≈ 0.5–0.7, aerobats lower, powered gliders ≈ 0.4–0.5.' },
    { key: 'vv',          group: 'tail',     label: 'V-tail volume Vᵥ', unit: '-',  def: 0.035, min: 0.015, max: 0.080, step: 0.001,
      teach: 'Vertical tail volume Vᵥ = Sᵥ·Lₜ/(S·b) — yaw stiffness, the "weathervane" authority. 0.02–0.05 covers most conventional layouts; more for short fuselages and pusher props.' },
    { key: 'arH',         group: 'tail',     label: 'H-tail aspect ratio', unit: '-', def: 4.0,  min: 2.0,   max: 7.0,   step: 0.1,
      teach: 'Aspect ratio of the tailplane (V-tail: of the combined panels). Higher AR steepens the tail lift-curve slope — more stabilizing power per unit area — but leaves the tail itself less stall margin.' },
    { key: 'arV',         group: 'tail',     label: 'Fin aspect ratio',   unit: '-', def: 1.5,  min: 0.8,   max: 3.0,   step: 0.1,
      teach: 'Fin height squared over fin area. Tall slender fins bite cleaner air and are more effective per area; short wide fins are stiffer and tolerate prop wash and grass landings better.' },
    { key: 'tailTaper',   group: 'tail',     label: 'Tail taper ratio',   unit: 'tip/root', def: 0.7, min: 0.4, max: 1.0, step: 0.05,
      teach: 'Tip/root chord of the tail surfaces. At this model fidelity it mainly shapes the drawn planform and the tail tip Reynolds number; structurally it lightens the tip.' },
    // aerodynamics
    { key: 'airfoil',     group: 'aero',     label: 'Wing airfoil',       unit: 'section', def: 'clarky', options: AIRFOILS,
      teach: 'The section sets how much lift the wing can generate (cl max → stall speed), its zero-lift drag floor, and its pitching moment — the nose-down torque the tail must continuously trim out.' },
    { key: 'oswald',      group: 'aero',     label: 'Oswald efficiency e', unit: '-',    def: 0.80,  min: 0.50,  max: 0.95,  step: 0.01,
      teach: 'Span-efficiency factor in the induced-drag term CL²/(π·e·AR). A perfect elliptical loading is e = 1; real monoplanes run 0.7–0.9. Planform taper, washout, and tip treatment move it.' },
    // mass budget
    { key: 'structure',   group: 'mass',     label: 'Structure mass',     unit: 'g',     def: 420,   min: 20,    max: 60000, step: 5,
      teach: 'Airframe: wing, fuselage, tail, gear. On built aircraft it typically runs 35–50 % of all-up weight. Every gram here compounds — it raises wing loading, which raises stall speed and power required.' },
    { key: 'payload',     group: 'mass',     label: 'Payload mass',       unit: 'g',     def: 200,   min: 0,     max: 50000, step: 5,
      teach: 'The mission: camera, sensor, cargo. The aircraft exists to carry this — good practice is to size the airframe around the payload, not squeeze the payload into an airframe.' },
    { key: 'avionics',    group: 'mass',     label: 'Avionics + servos',  unit: 'g',     def: 60,    min: 0,     max: 10000,  step: 5,
      teach: 'Receiver, servos, flight controller, GPS, wiring. Nearly constant across aircraft sizes, so it punishes small airframes disproportionately — one reason micros fly worse than their numbers suggest.' },
    { key: 'propMass',    group: 'mass',     label: 'Motor + ESC + prop', unit: 'g',     def: 130,   min: 0,     max: 25000,  step: 5,
      teach: 'The complete propulsion group mass. Scales roughly with max power (≈ 2–4 W per gram for hobby outrunners). The motor presets below fill realistic combos.' },
    // propulsion + battery
    { key: 'battCapacity',group: 'power',    label: 'Battery capacity',   unit: 'mAh',   def: 2200,  min: 100,   max: 200000, step: 50,
      teach: 'Energy on board grows linearly with capacity — and so does pack mass. Endurance therefore grows sub-linearly: each added cell of capacity also makes the aircraft heavier and hungrier.' },
    { key: 'battCells',   group: 'power',    label: 'Battery cells',      unit: 'S',     def: 3,     min: 1,     max: 14,    step: 1,
      teach: 'Series cells set pack voltage (3.7 V nominal each). Voltage decides which motor Kv is sensible and, with capacity, the total energy. Higher voltage moves the same power at lower current.' },
    { key: 'battDensity', group: 'power',    label: 'Pack energy density',unit: 'Wh/kg', def: 150,   min: 60,    max: 300,   step: 5,
      teach: 'Energy per kilogram of pack. LiPo ≈ 130–160 Wh/kg with high discharge rate; Li-ion ≈ 220–260 Wh/kg but limited current. The single biggest technology lever on endurance.' },
    { key: 'usableBatt',  group: 'power',    label: 'Usable capacity',    unit: 'fraction', def: 0.80, min: 0.50, max: 1.00, step: 0.01,
      teach: 'Fraction of capacity the mission may consume. 80 % protects LiPo cycle life and keeps a go-around reserve; Li-ion tolerates deeper discharge.' },
    { key: 'maxPower',    group: 'power',    label: 'Max electrical power', unit: 'W',   def: 350,   min: 5,     max: 50000, step: 5,
      teach: 'Full-throttle electrical draw. Through the efficiency chain it caps static thrust and climb rate, and sets how much of the power-required curve the aircraft can actually reach.' },
    { key: 'propDiameter',group: 'power',    label: 'Prop diameter',      unit: 'in',    def: 10,    min: 3,     max: 60,    step: 0.5,
      teach: 'A bigger disk makes more thrust per watt at low speed — actuator-disk physics: T ∝ (2ρA·P²)^⅓. Traded against ground clearance, RPM matching, and tip noise.' },
    { key: 'etaProp',     group: 'power',    label: 'Prop efficiency (cruise)', unit: '-', def: 0.55, min: 0.20, max: 0.90,  step: 0.01,
      teach: 'Fraction of shaft power that becomes thrust power at cruise. A well-matched prop near its design advance ratio reaches 0.6–0.7; a badly matched one silently wastes a third of the battery.' },
    { key: 'etaMotor',    group: 'power',    label: 'Motor + ESC efficiency', unit: '-', def: 0.85,  min: 0.50,  max: 0.98,  step: 0.01,
      teach: 'Electrical-to-shaft efficiency of motor plus ESC. Good outrunners near their sweet spot run 0.80–0.90; heavily loaded or badly Kv-matched motors fall well below and turn the loss into heat.' },
    // operating point
    { key: 'cruiseSpeed', group: 'ops',      label: 'Cruise speed',       unit: 'm/s',   def: 14,    min: 2,     max: 100,    step: 0.5,
      teach: 'The operating point for every cruise number on this page. Fly at the best-L/D speed to maximize range; fly slower, at the minimum-power speed (≈ 0.76 × V_LD), to maximize endurance.' },
    { key: 'altitude',    group: 'ops',      label: 'Field altitude',     unit: 'm MSL', def: 0,     min: 0,     max: 5000,  step: 50,
      teach: 'Air density falls about 1 % per 100 m. Thin air demands higher true airspeed for the same lift, robs the prop of static thrust, and slightly reduces drag.' }
  ];

  var GROUPS = [
    { id: 'geometry', label: 'Wing + fuselage geometry' },
    { id: 'tail',     label: 'Tail geometry' },
    { id: 'aero',     label: 'Aerodynamics' },
    { id: 'mass',     label: 'Mass budget' },
    { id: 'power',    label: 'Propulsion + battery' },
    { id: 'ops',      label: 'Operating point + environment' }
  ];

  /* ── COTS presets ─────────────────────────────────────────────────────
   * Approximate class values for common hobby hardware, labeled by size
   * class rather than brand. Applying a preset writes the listed PARAMS keys;
   * everything stays editable afterwards.
   */
  var PRESETS = {
    airframe: {
      label: 'Airframes',
      note: 'sets geometry, tail, airfoil, structure mass',
      items: [
        { id: 'micro800', label: '800 mm micro park flyer',
          info: 'foam · 0.13 m² · flat-plate wing',
          specs: { span: 0.80, rootChord: 0.16, taper: 0.90, sweepLE: 0, dihedral: 3, fusLength: 0.65, fusDiameter: 0.06, tailArm: 0.38, vh: 0.50, vv: 0.035, tailType: 'conventional', airfoil: 'flat', structure: 120 } },
        { id: 'ft1200', label: '1200 mm foamboard scratch build (FT-style)',
          info: 'flat foamboard · constant chord · cheap and crashable',
          specs: { span: 1.20, rootChord: 0.30, taper: 1.00, sweepLE: 0, dihedral: 2, fusLength: 0.90, fusDiameter: 0.10, tailArm: 0.55, vh: 0.50, vv: 0.035, tailType: 'conventional', airfoil: 'flat', structure: 400 } },
        { id: 'trainer1400', label: '1400 mm foam high-wing trainer (Apprentice-class)',
          info: 'molded foam · Clark Y · self-leveling dihedral',
          specs: { span: 1.40, rootChord: 0.23, taper: 0.85, sweepLE: 0, dihedral: 5, fusLength: 1.10, fusDiameter: 0.11, tailArm: 0.62, vh: 0.55, vv: 0.040, tailType: 'conventional', airfoil: 'clarky', structure: 780 } },
        { id: 'glider2000', label: '2000 mm powered sailplane (Radian-class)',
          info: 'slender pod · T-tail · thermal floater',
          specs: { span: 2.00, rootChord: 0.185, taper: 0.60, sweepLE: 0, dihedral: 6, fusLength: 1.15, fusDiameter: 0.065, tailArm: 0.70, vh: 0.45, vv: 0.030, tailType: 'ttail', airfoil: 'sd7037', structure: 480 } },
        { id: 'maptalon1300', label: '1300 mm mapping pusher (Mini Talon-class)',
          info: 'V-tail · pusher prop keeps the camera view clean',
          specs: { span: 1.30, rootChord: 0.20, taper: 0.75, sweepLE: 3, dihedral: 2, fusLength: 0.83, fusDiameter: 0.13, tailArm: 0.55, vh: 0.50, vv: 0.040, tailType: 'vtail', airfoil: 'mh32', structure: 650 } },
        { id: 'believer1960', label: '1960 mm survey twin (Believer-class)',
          info: 'big fuselage volume · long-endurance mapping',
          specs: { span: 1.96, rootChord: 0.24, taper: 0.65, sweepLE: 2, dihedral: 3, fusLength: 1.20, fusDiameter: 0.14, tailArm: 0.72, vh: 0.55, vv: 0.045, tailType: 'conventional', airfoil: 'sd7037', structure: 1650 } },
        { id: 'eglider2400', label: '2400 mm thermal e-glider',
          info: 'high AR · AG35 · built for minimum sink',
          specs: { span: 2.40, rootChord: 0.20, taper: 0.55, sweepLE: 0, dihedral: 4, fusLength: 1.25, fusDiameter: 0.06, tailArm: 0.85, vh: 0.50, vv: 0.030, tailType: 'ttail', airfoil: 'ag35', structure: 900 } },
        { id: 'cargo2100', label: '2100 mm heavy-lift cargo (student UAS class)',
          info: 'high-lift section · sized around the payload bay',
          specs: { span: 2.10, rootChord: 0.33, taper: 0.70, sweepLE: 0, dihedral: 3, fusLength: 1.40, fusDiameter: 0.16, tailArm: 0.85, vh: 0.60, vv: 0.045, tailType: 'conventional', airfoil: 'naca4412', structure: 2200 } },
        { id: 'survey3200', label: '3200 mm long-endurance survey (22 kg class)',
          info: 'composite · high AR · catapult or runway launch',
          specs: { span: 3.20, rootChord: 0.42, taper: 0.60, sweepLE: 2, dihedral: 2, fusLength: 2.20, fusDiameter: 0.25, tailArm: 1.35, vh: 0.55, vv: 0.040, tailType: 'ttail', airfoil: 'e205', structure: 9000 } },
        { id: 'cargo5500', label: '5500 mm heavy cargo UAV (100 kg class)',
          info: 'runway launch · sized around a 30 kg payload bay',
          specs: { span: 5.50, rootChord: 0.62, taper: 0.65, sweepLE: 0, dihedral: 2, fusLength: 3.60, fusDiameter: 0.45, tailArm: 2.20, vh: 0.60, vv: 0.050, tailType: 'conventional', airfoil: 'naca4412', structure: 42000 } }
      ]
    },
    motor: {
      label: 'Motors (motor + ESC + prop combo)',
      note: 'sets propulsion mass, max power, prop diameter, cells',
      items: [
        { id: 'm1806', label: '1806 · 2300 kV micro',    info: '5×4.5 · 2–3S · ≈45 g combo',  specs: { propMass: 45,  maxPower: 110,  propDiameter: 5,   battCells: 3 } },
        { id: 'm2204', label: '2204 · 2300 kV mini',     info: '6×4 · 3S · ≈60 g combo',      specs: { propMass: 60,  maxPower: 150,  propDiameter: 6,   battCells: 3 } },
        { id: 'm2212', label: '2212 · 1000 kV classic',  info: '10×4.7 · 3S · ≈105 g combo',  specs: { propMass: 105, maxPower: 200,  propDiameter: 10,  battCells: 3 } },
        { id: 'm2216', label: '2216 · 880 kV',           info: '11×7 · 3–4S · ≈140 g combo',  specs: { propMass: 140, maxPower: 280,  propDiameter: 11,  battCells: 4 } },
        { id: 'm2814', label: '2814 · 900 kV',           info: '12×6 · 4S · ≈180 g combo',    specs: { propMass: 180, maxPower: 450,  propDiameter: 12,  battCells: 4 } },
        { id: 'm4108', label: '4108 · 480 kV',           info: '15×8 · 6S · ≈280 g combo',    specs: { propMass: 280, maxPower: 700,  propDiameter: 15,  battCells: 6 } },
        { id: 'm5010', label: '5010 · 300 kV large',     info: '18×6.5 · 6S · ≈420 g combo',  specs: { propMass: 420, maxPower: 900,  propDiameter: 18,  battCells: 6 } },
        { id: 'm8318', label: '8318 · 120 kV heavy-lift', info: '29×9.5 · 12S · ≈1.3 kg combo', specs: { propMass: 1300, maxPower: 4000, propDiameter: 29, battCells: 12 } },
        { id: 'm15kw', label: '15 kW class UAV powertrain', info: '40 in · 14S · ≈6 kg combo',  specs: { propMass: 6000, maxPower: 15000, propDiameter: 40, battCells: 14 } }
      ]
    },
    battery: {
      label: 'Batteries',
      note: 'sets capacity, cells, energy density (from real pack mass)',
      items: [
        { id: 'b2s800',   label: '2S 800 mAh 45 C LiPo',    info: '≈45 g · 5.9 Wh',    specs: { battCapacity: 800,   battCells: 2, battDensity: 131 } },
        { id: 'b3s1300',  label: '3S 1300 mAh 45 C LiPo',   info: '≈115 g · 14.4 Wh',  specs: { battCapacity: 1300,  battCells: 3, battDensity: 125 } },
        { id: 'b3s2200',  label: '3S 2200 mAh 25 C LiPo',   info: '≈185 g · 24.4 Wh',  specs: { battCapacity: 2200,  battCells: 3, battDensity: 132 } },
        { id: 'b3s5000',  label: '3S 5000 mAh 20 C LiPo',   info: '≈400 g · 55.5 Wh',  specs: { battCapacity: 5000,  battCells: 3, battDensity: 139 } },
        { id: 'b4s3300',  label: '4S 3300 mAh 35 C LiPo',   info: '≈340 g · 48.8 Wh',  specs: { battCapacity: 3300,  battCells: 4, battDensity: 144 } },
        { id: 'b4s5200',  label: '4S 5200 mAh 15 C LiPo',   info: '≈480 g · 77.0 Wh',  specs: { battCapacity: 5200,  battCells: 4, battDensity: 160 } },
        { id: 'b6s5000',  label: '6S 5000 mAh 25 C LiPo',   info: '≈760 g · 111 Wh',   specs: { battCapacity: 5000,  battCells: 6, battDensity: 146 } },
        { id: 'bli3s35',  label: '3S 3500 mAh Li-ion (18650)', info: '≈160 g · 38.9 Wh · ≤2 C', specs: { battCapacity: 3500, battCells: 3, battDensity: 243 } },
        { id: 'bli4s7',   label: '4S2P 7000 mAh Li-ion (18650)', info: '≈420 g · 104 Wh · ≤2 C', specs: { battCapacity: 7000, battCells: 4, battDensity: 247 } },
        { id: 'b12s22',   label: '12S 22000 mAh 25 C LiPo', info: '≈6.0 kg · 977 Wh',  specs: { battCapacity: 22000, battCells: 12, battDensity: 163 } },
        { id: 'b14s30li', label: '14S3P 30000 mAh Li-ion',  info: '≈7.8 kg · 1554 Wh · ≤3 C', specs: { battCapacity: 30000, battCells: 14, battDensity: 199 } }
      ]
    }
  };

  /* ── derived-metric registry (Monte Carlo constraints/objectives) ────── */
  var METRICS = [
    { key: 'massTotal',    label: 'All-up mass',          unit: 'g',      dec: 0 },
    { key: 'battMass',     label: 'Battery mass',         unit: 'g',      dec: 0 },
    { key: 'area',         label: 'Wing area',            unit: 'dm²', dec: 1 },
    { key: 'aspectRatio',  label: 'Aspect ratio',         unit: '-',      dec: 2 },
    { key: 'mac',          label: 'Mean aero chord',      unit: 'm',      dec: 3 },
    { key: 'areaH',        label: 'H-tail area (proj.)',  unit: 'dm²', dec: 1 },
    { key: 'areaV',        label: 'Fin area (proj.)',     unit: 'dm²', dec: 1 },
    { key: 'totalLength',  label: 'Total length (nose→tail)', unit: 'm', dec: 2 },
    { key: 'wingLoading',  label: 'Wing loading',         unit: 'g/dm²', dec: 1 },
    { key: 'vstall',       label: 'Stall speed',          unit: 'm/s',    dec: 1 },
    { key: 'stallMargin',  label: 'Cruise / stall ratio', unit: '-',      dec: 2 },
    { key: 'clCruise',     label: 'CL at cruise',         unit: '-',      dec: 3 },
    { key: 'ldCruise',     label: 'L/D at cruise',        unit: '-',      dec: 1 },
    { key: 'ldMax',        label: 'L/D max',              unit: '-',      dec: 1 },
    { key: 'vLdMax',       label: 'Speed at L/D max',     unit: 'm/s',    dec: 1 },
    { key: 'cruisePowerE', label: 'Cruise power (elec)',  unit: 'W',      dec: 1 },
    { key: 'throttle',     label: 'Cruise throttle',      unit: '%',      dec: 0 },
    { key: 'current',      label: 'Cruise current',       unit: 'A',      dec: 2 },
    { key: 'cRate',        label: 'Cruise C-rate',        unit: 'C',      dec: 1 },
    { key: 'endurance',    label: 'Endurance',            unit: 'min',    dec: 0 },
    { key: 'range',        label: 'Still-air range',      unit: 'km',     dec: 1 },
    { key: 'roc',          label: 'Max rate of climb',    unit: 'm/s',    dec: 1 },
    { key: 'staticThrust', label: 'Static thrust',        unit: 'g',      dec: 0 },
    { key: 'thrustWeight', label: 'Thrust / weight',      unit: '-',      dec: 2 },
    { key: 'staticMargin', label: 'Static margin',        unit: '% MAC',  dec: 1 },
    { key: 'npMac',        label: 'Neutral point',        unit: '% MAC',  dec: 1 },
    { key: 'reCruise',     label: 'Re at cruise (MAC)',   unit: '-',      dec: 0 },
    { key: 'reTipStall',   label: 'Re at tip, stall',     unit: '-',      dec: 0 }
  ];

  var paramByKey = {};
  PARAMS.forEach(function (p) { paramByKey[p.key] = p; });
  var metricByKey = {};
  METRICS.forEach(function (m) { metricByKey[m.key] = m; });

  /* ── the model ────────────────────────────────────────────────────────
   * derive(design) — pure. All formulas documented in the page's model notes.
   */
  function airDensity(altM) {
    var t = 288.15 - 0.0065 * altM;
    return 1.225 * Math.pow(t / 288.15, 4.2561);
  }

  function derive(d) {
    var foil = AIRFOILS[d.airfoil] || AIRFOILS.clarky;
    var rho = airDensity(d.altitude);

    // planform
    var tipChord = d.rootChord * d.taper;
    var S = d.span * d.rootChord * (1 + d.taper) / 2;           // m^2
    var AR = d.span * d.span / S;
    var mac = (2 / 3) * d.rootChord * (1 + d.taper + d.taper * d.taper) / (1 + d.taper);
    var yMac = (d.span / 6) * (1 + 2 * d.taper) / (1 + d.taper);

    // tail sizing from volume coefficients (projected/effective areas)
    var shEff = d.vh * S * mac / d.tailArm;                     // m^2, horizontal projection
    var svEff = d.vv * S * d.span / d.tailArm;                  // m^2, vertical projection
    var tail = { type: d.tailType };
    if (d.tailType === 'vtail') {
      // classic conversion: total V-tail area = Sh + Sv, panel dihedral from the split
      tail.gamma = Math.atan(Math.sqrt(svEff / Math.max(shEff, 1e-9)));
      tail.area = shEff + svEff;
      tail.span = Math.sqrt(d.arH * tail.area);                 // true (slant) span
      tail.rootChord = 2 * tail.area / (tail.span * (1 + d.tailTaper));
    } else {
      tail.spanH = Math.sqrt(d.arH * shEff);
      tail.rootChordH = 2 * shEff / (tail.spanH * (1 + d.tailTaper));
      tail.heightV = Math.sqrt(d.arV * svEff);
      tail.rootChordV = 2 * svEff / (tail.heightV * (1 + d.tailTaper));
    }

    // overall length, nose to aft-most tail edge (same placement the drawings use)
    var wingRootLEx = 0.30 * d.fusLength;
    var macLEx = wingRootLEx + yMac * Math.tan(d.sweepLE * Math.PI / 180);
    var xTailC4 = macLEx + 0.25 * mac + d.tailArm;
    var aftChord = d.tailType === 'vtail' ? tail.rootChord : Math.max(tail.rootChordH, tail.rootChordV);
    var totalLength = Math.max(d.fusLength, xTailC4 + 0.75 * aftChord);

    // mass budget
    var battWh = (d.battCapacity / 1000) * d.battCells * CELL_V;
    var battMassKg = battWh / d.battDensity;
    var massKg = (d.structure + d.payload + d.avionics + d.propMass) / 1000 + battMassKg;
    var weightN = massKg * G;

    // lift limits (finite-wing knockdown on the 2-D section)
    var clMax3D = 0.9 * foil.clmax;
    var claw = foil.cla / (1 + foil.cla / (Math.PI * d.oswald * AR)); // per rad, 3-D
    var vstall = Math.sqrt(2 * weightN / (rho * S * clMax3D));

    // parasite drag buildup (referenced to wing area), +15% interference/misc
    var fusWetted = Math.PI * d.fusDiameter * d.fusLength * 0.8;
    var cd0Fus = 0.006 * fusWetted / S;
    var cd0Tail = 0.008 * (shEff + svEff) / S;
    var cd0 = 1.15 * (foil.cd0 + cd0Fus + cd0Tail);
    var k = 1 / (Math.PI * d.oswald * AR);

    // cruise point
    var v = d.cruiseSpeed;
    var q = 0.5 * rho * v * v;
    var clCruise = weightN / (q * S);
    var cdCruise = cd0 + k * clCruise * clCruise;
    var dragN = q * S * cdCruise;
    var pMechCruise = dragN * v;
    var pElecCruise = pMechCruise / (d.etaProp * d.etaMotor);
    var packV = d.battCells * CELL_V;
    var current = pElecCruise / packV;
    var cRate = current / (d.battCapacity / 1000);
    var enduranceH = (d.battCapacity / 1000) * d.usableBatt / current;
    var rangeKm = v * 3.6 * enduranceH;

    // best-glide numbers
    var clStar = Math.sqrt(cd0 / k);
    var ldMax = 1 / (2 * Math.sqrt(k * cd0));
    var vLdMax = Math.sqrt(2 * weightN / (rho * S * clStar));

    // climb: excess power at the minimum-power speed (CL = sqrt(3*CD0/k))
    var clMinP = Math.sqrt(3 * cd0 / k);
    var clMinPCl = Math.min(clMinP, clMax3D);
    var vMinP = Math.sqrt(2 * weightN / (rho * S * clMinPCl));
    var cdMinP = cd0 + k * clMinPCl * clMinPCl;
    var pReqMinMech = 0.5 * rho * vMinP * vMinP * vMinP * S * cdMinP;
    var pAvailMech = d.maxPower * d.etaMotor * d.etaProp;
    var roc = Math.max(0, (pAvailMech - pReqMinMech) / weightN);

    // static thrust: actuator disk with a 0.7 static figure of merit
    var diskA = Math.PI * Math.pow(d.propDiameter * 0.0254, 2) / 4;
    var pShaft = d.maxPower * d.etaMotor;
    var staticThrustN = 0.7 * Math.pow(2 * rho * diskA, 1 / 3) * Math.pow(pShaft, 2 / 3);
    var tw = staticThrustN / weightN;

    // longitudinal stability: tail-volume neutral point with downwash,
    // 0.9 tail efficiency, and a -4% MAC fuselage (Munk) correction.
    // Tail lift-curve slope from the configured tail AR; a T-tail sits above
    // the wake and sees ~30% less downwash gradient.
    var clat = 5.8 / (1 + 5.8 / (Math.PI * 0.9 * d.arH));
    var dedaFactor = d.tailType === 'ttail' ? 0.7 : 1.0;
    var deda = Math.min(0.9, dedaFactor * 2 * claw / (Math.PI * AR));
    var npFrac = 0.25 + 0.9 * d.vh * (clat / claw) * (1 - deda) - 0.04;
    var smFrac = npFrac - d.cgMac / 100;

    return {
      foil: foil, rho: rho, tail: tail,
      tipChord: tipChord, S: S, shEff: shEff, svEff: svEff, yMac: yMac,
      weightN: weightN, battWh: battWh,
      cd0: cd0, k: k, claw: claw, clat: clat, deda: deda, clMax3D: clMax3D,
      pAvailMech: pAvailMech, packV: packV,
      // registry metrics
      massTotal: massKg * 1000,
      battMass: battMassKg * 1000,
      area: S * 100,
      aspectRatio: AR,
      mac: mac,
      areaH: shEff * 100,
      areaV: svEff * 100,
      totalLength: totalLength,
      wingLoading: massKg * 1000 / (S * 100),
      vstall: vstall,
      stallMargin: v / vstall,
      clCruise: clCruise,
      ldCruise: clCruise / cdCruise,
      ldMax: ldMax,
      vLdMax: vLdMax,
      cruisePowerE: pElecCruise,
      throttle: 100 * pElecCruise / d.maxPower,
      current: current,
      cRate: cRate,
      endurance: enduranceH * 60,
      range: rangeKm,
      roc: roc,
      staticThrust: staticThrustN / G * 1000,
      thrustWeight: tw,
      staticMargin: smFrac * 100,
      npMac: npFrac * 100,
      reCruise: rho * v * mac / MU_AIR,
      reTipStall: rho * vstall * tipChord / MU_AIR
    };
  }

  // electrical power required at speed v (for the power chart + hover)
  function powerElecAt(d, r, v) {
    var q = 0.5 * r.rho * v * v;
    var cl = r.weightN / (q * r.S);
    if (cl > r.clMax3D) return NaN; // below stall
    var cd = r.cd0 + r.k * cl * cl;
    return q * r.S * cd * v / (d.etaProp * d.etaMotor);
  }

  /* ── design checks ────────────────────────────────────────────────────── */
  function designChecks(d, r) {
    function band(v, okLo, okHi, warnLo, warnHi) {
      if (v >= okLo && v <= okHi) return 'ok';
      if (v >= warnLo && v <= warnHi) return 'warn';
      return 'fail';
    }
    return [
      { label: 'Static margin', value: fmt(r.staticMargin, 1) + ' % MAC', limit: '5–15 % stable, docile',
        status: band(r.staticMargin, 5, 15, 2, 25) },
      { label: 'Thrust / weight', value: fmt(r.thrustWeight, 2), limit: '≥ 0.60 sport; ≥ 0.35 gentle',
        status: r.thrustWeight >= 0.6 ? 'ok' : r.thrustWeight >= 0.35 ? 'warn' : 'fail' },
      { label: 'Cruise / stall speed', value: fmt(r.stallMargin, 2), limit: '≥ 1.4 comfortable margin',
        status: r.stallMargin >= 1.4 ? 'ok' : r.stallMargin >= 1.2 ? 'warn' : 'fail' },
      { label: 'CL cruise vs CL max', value: fmt(r.clCruise, 2) + ' / ' + fmt(r.clMax3D, 2), limit: '≤ 70 % of CL max',
        status: r.clCruise <= 0.7 * r.clMax3D ? 'ok' : r.clCruise <= 0.9 * r.clMax3D ? 'warn' : 'fail' },
      { label: 'Cruise throttle', value: fmt(r.throttle, 0) + ' %', limit: '≤ 60 % leaves climb reserve',
        status: r.throttle <= 60 ? 'ok' : r.throttle <= 85 ? 'warn' : 'fail' },
      { label: 'Cruise C-rate', value: fmt(r.cRate, 1) + ' C', limit: '≤ 20 C sustained draw',
        status: r.cRate <= 20 ? 'ok' : r.cRate <= 35 ? 'warn' : 'fail' },
      { label: 'Tip Reynolds at stall', value: fmtInt(r.reTipStall), limit: '≥ 100k avoids tip-stall regime',
        status: r.reTipStall >= 100000 ? 'ok' : r.reTipStall >= 50000 ? 'warn' : 'fail' }
    ];
  }

  /* ── formatting ──────────────────────────────────────────────────────── */
  function fmt(v, dec) {
    if (!isFinite(v) || isNaN(v)) return DASH;
    return v.toFixed(dec);
  }
  function fmtInt(v) {
    if (!isFinite(v) || isNaN(v)) return DASH;
    v = Math.round(v);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  function fmtMetric(key, v) {
    var m = metricByKey[key];
    if (m) return (m.dec === 0 ? fmtInt(v) : fmt(v, m.dec));
    var p = paramByKey[key];
    if (p) return fmt(v, decimalsOf(p.step));
    return fmt(v, 2);
  }
  function decimalsOf(step) {
    var s = String(step);
    var i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ── state ───────────────────────────────────────────────────────────── */
  var design = defaultDesign();
  var derived = null;
  var mcResult = null;
  var activePreset = { airframe: null, motor: null, battery: null };

  function defaultDesign() {
    var d = {};
    PARAMS.forEach(function (p) { d[p.key] = p.def; });
    return d;
  }

  /* ── parameter form (generated from PARAMS) ──────────────────────────── */
  function buildForm() {
    var host = document.getElementById('uav-form');
    var html = '';
    GROUPS.forEach(function (g) {
      html += '<div class="uav-group-label">' + esc(g.label) + '</div>';
      html += '<div class="tools-form">';
      PARAMS.filter(function (p) { return p.group === g.id; }).forEach(function (p) {
        html += '<label><span>' + esc(p.label) + ' (' + esc(p.unit) + ')</span>';
        if (p.options) {
          html += '<select data-param="' + p.key + '">';
          Object.keys(p.options).forEach(function (k) {
            html += '<option value="' + k + '">' + esc(p.options[k].label) + '</option>';
          });
          html += '</select>';
        } else {
          html += '<input type="number" data-param="' + p.key + '" min="' + p.min + '" max="' + p.max +
                  '" step="' + p.step + '" autocomplete="off" inputmode="decimal">';
        }
        html += '</label>';
      });
      html += '</div>';
    });
    host.innerHTML = html;
    host.addEventListener('input', function (e) {
      var key = e.target.getAttribute('data-param');
      if (!key) return;
      var p = paramByKey[key];
      if (p.options) {
        design[key] = e.target.value;
      } else {
        var v = parseFloat(e.target.value);
        if (!isFinite(v)) return; // keep last valid value while the user types
        design[key] = Math.min(p.max, Math.max(p.min, v));
      }
      designTouched = true;
      notePresetDivergence(key);
      recompute();
    });
  }

  function syncForm() {
    PARAMS.forEach(function (p) {
      var el = document.querySelector('[data-param="' + p.key + '"]');
      if (!el) return;
      if (p.options) el.value = design[p.key];
      else el.value = String(+design[p.key].toFixed(6));
    });
  }

  /* ── COTS preset tables ──────────────────────────────────────────────── */
  function buildPresetTables() {
    var host = document.getElementById('uav-presets');
    var html = '';
    Object.keys(PRESETS).forEach(function (cat) {
      var c = PRESETS[cat];
      html += '<div class="uav-group-label">' + esc(c.label) + ' <span class="uav-preset-note">&mdash; ' + esc(c.note) + '</span></div>';
      html += '<div class="table-scroll"><table class="tools-ref-table uav-preset-table"><tbody>';
      c.items.forEach(function (it) {
        html += '<tr id="preset-' + cat + '-' + it.id + '">' +
          '<td class="uav-preset-name">' + esc(it.label) + '</td>' +
          '<td class="desc">' + esc(it.info) + '</td>' +
          '<td class="tool-cta"><a href="#" data-preset="' + cat + ':' + it.id + '">Apply &rarr;</a></td></tr>';
      });
      html += '</tbody></table></div>';
    });
    host.innerHTML = html;
    host.addEventListener('click', function (e) {
      var a = e.target.closest('[data-preset]');
      if (!a) return;
      e.preventDefault();
      var parts = a.getAttribute('data-preset').split(':');
      applyPreset(parts[0], parts[1]);
    });
  }

  function applyPreset(cat, id) {
    var item = null;
    PRESETS[cat].items.forEach(function (it) { if (it.id === id) item = it; });
    if (!item) return;
    var setKeys = [], changedKeys = [];
    Object.keys(item.specs).forEach(function (key) {
      var p = paramByKey[key];
      if (!p) return;
      var v = p.options ? item.specs[key] : Math.min(p.max, Math.max(p.min, item.specs[key]));
      if (design[key] !== v) changedKeys.push(key);
      design[key] = v;
      setKeys.push(p.label);
    });
    activePreset[cat] = id;
    designTouched = true;
    // a spec that actually changes another category's keys invalidates that selection
    Object.keys(PRESETS).forEach(function (other) {
      if (other === cat) return;
      if (activePreset[other] && changedKeys.some(function (k) { return presetOwns(other, k); })) {
        activePreset[other] = null;
      }
    });
    syncForm();
    recompute();
    renderPresetStatus();
    document.getElementById('uav-preset-status').textContent =
      'Applied ' + item.label + ' — set: ' + setKeys.join(', ') + '. All values remain editable.';
  }

  function presetOwns(cat, key) {
    return PRESETS[cat].items.some(function (it) { return key in it.specs; });
  }

  function notePresetDivergence(key) {
    var changed = false;
    Object.keys(PRESETS).forEach(function (cat) {
      if (activePreset[cat] && presetOwns(cat, key)) { activePreset[cat] = null; changed = true; }
    });
    if (changed) renderPresetStatus();
  }

  function renderPresetStatus() {
    Object.keys(PRESETS).forEach(function (cat) {
      PRESETS[cat].items.forEach(function (it) {
        var row = document.getElementById('preset-' + cat + '-' + it.id);
        if (row) row.classList.toggle('uav-preset-active', activePreset[cat] === it.id);
      });
    });
  }

  /* ── readouts ────────────────────────────────────────────────────────── */
  var READOUTS = [
    { key: 'massTotal',    sub: function (r) { return 'battery ' + fmtInt(r.battMass) + ' g · ' + fmt(r.battWh, 1) + ' Wh'; } },
    { key: 'wingLoading',  sub: function (r) { return fmt(r.massTotal / 1000 / r.S, 2) + ' kg/m²'; } },
    { key: 'area',         sub: function (r) { return 'AR ' + fmt(r.aspectRatio, 2) + ' · MAC ' + fmt(r.mac * 1000, 0) + ' mm'; } },
    { key: 'areaH',        sub: function (r) {
        return r.tail.type === 'vtail'
          ? 'V-tail Γ ' + fmt(r.tail.gamma * 180 / Math.PI, 0) + '° · true area ' + fmt(r.tail.area * 100, 1) + ' dm²'
          : 'span ' + fmt(r.tail.spanH, 2) + ' m · root ' + fmt(r.tail.rootChordH * 1000, 0) + ' mm'; } },
    { key: 'areaV',        sub: function (r) {
        return r.tail.type === 'vtail'
          ? 'projected from the V panels'
          : 'height ' + fmt(r.tail.heightV, 2) + ' m · root ' + fmt(r.tail.rootChordV * 1000, 0) + ' mm'; } },
    { key: 'totalLength',  sub: function (r) { return 'fuselage ' + fmt(design.fusLength, 2) + ' m · overhang ' + fmt(Math.max(0, r.totalLength - design.fusLength), 2) + ' m'; } },
    { key: 'vstall',       sub: function (r) { return fmt(r.vstall * 3.6, 1) + ' km/h at CL ' + fmt(r.clMax3D, 2); } },
    { key: 'ldCruise',     sub: function (r) { return 'L/D max ' + fmt(r.ldMax, 1) + ' at ' + fmt(r.vLdMax, 1) + ' m/s'; } },
    { key: 'cruisePowerE', sub: function (r) { return fmt(r.throttle, 0) + ' % throttle · ' + fmt(r.current, 1) + ' A · ' + fmt(r.cRate, 1) + ' C'; } },
    { key: 'endurance',    sub: function (r) { return 'range ' + fmt(r.range, 1) + ' km still air'; } },
    { key: 'roc',          sub: function (r) { return 'excess power at Vₘᴘ · full throttle'; } },
    { key: 'thrustWeight', sub: function (r) { return 'static thrust ' + fmtInt(r.staticThrust) + ' g'; } },
    { key: 'staticMargin', sub: function (r) { return 'NP at ' + fmt(r.npMac, 1) + ' % MAC'; } },
    { key: 'stallMargin',  sub: function (r) { return 'cruise ' + fmt(design.cruiseSpeed, 1) + ' / stall ' + fmt(r.vstall, 1) + ' m/s'; } },
    { key: 'reCruise',     sub: function (r) { return 'tip at stall ' + fmtInt(r.reTipStall); } }
  ];

  function renderReadouts(r) {
    var html = '';
    READOUTS.forEach(function (ro) {
      var m = metricByKey[ro.key];
      html += '<div class="tools-readout">' +
        '<span class="tools-readout-label">' + esc(m.label) + '</span>' +
        '<span class="tools-readout-value mono">' + fmtMetric(ro.key, r[ro.key]) +
        (m.unit !== '-' ? '<span class="uav-unit"> ' + esc(m.unit) + '</span>' : '') + '</span>' +
        '<span class="tools-readout-sub">' + ro.sub(r) + '</span></div>';
    });
    document.getElementById('uav-readouts').innerHTML = html;
  }

  function renderChecks(d, r) {
    var rows = designChecks(d, r);
    var html = '';
    var words = { ok: 'OK', warn: 'WARN', fail: 'FAIL' };
    rows.forEach(function (c) {
      html += '<tr><td>' + esc(c.label) + '</td><td class="num">' + c.value + '</td>' +
        '<td class="desc">' + c.limit + '</td>' +
        '<td class="uav-status uav-status-' + c.status + '">' + words[c.status] + '</td></tr>';
    });
    document.getElementById('uav-checks-body').innerHTML = html;
  }

  /* ── SVG helpers ─────────────────────────────────────────────────────── */
  function svgOpen(w, h) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" role="img">';
  }
  function line(x1, y1, x2, y2, cls) {
    return '<line x1="' + f2(x1) + '" y1="' + f2(y1) + '" x2="' + f2(x2) + '" y2="' + f2(y2) + '" class="' + cls + '"/>';
  }
  function poly(pts, cls) {
    return '<polygon points="' + pts.map(function (p) { return f2(p[0]) + ',' + f2(p[1]); }).join(' ') + '" class="' + cls + '"/>';
  }
  function path(dstr, cls) {
    return '<path d="' + dstr + '" class="' + cls + '"/>';
  }
  function text(x, y, s, cls, anchor) {
    return '<text x="' + f2(x) + '" y="' + f2(y) + '" class="' + cls + '"' +
      (anchor ? ' text-anchor="' + anchor + '"' : '') + '>' + esc(s) + '</text>';
  }
  function f2(v) { return (Math.round(v * 100) / 100).toString(); }

  function dimH(x1, x2, y, label) {
    return line(x1, y, x2, y, 'uav-dim') +
      line(x1, y - 4, x1, y + 4, 'uav-dim') + line(x2, y - 4, x2, y + 4, 'uav-dim') +
      text((x1 + x2) / 2, y - 5, label, 'uav-dim-label', 'middle');
  }

  function cgSymbol(x, y, r) {
    // quartered circle — standard CG mark
    var s = '<circle cx="' + f2(x) + '" cy="' + f2(y) + '" r="' + r + '" class="uav-cg-ring"/>';
    s += path('M ' + f2(x) + ' ' + f2(y) + ' L ' + f2(x + r) + ' ' + f2(y) + ' A ' + r + ' ' + r + ' 0 0 1 ' + f2(x) + ' ' + f2(y + r) + ' Z', 'uav-cg-fill');
    s += path('M ' + f2(x) + ' ' + f2(y) + ' L ' + f2(x - r) + ' ' + f2(y) + ' A ' + r + ' ' + r + ' 0 0 1 ' + f2(x) + ' ' + f2(y - r) + ' Z', 'uav-cg-fill');
    return s;
  }

  /* ── airframe geometry for drawing (x = 0 at the nose, meters) ───────── */
  function layout(d, r) {
    var wingRootLE = 0.30 * d.fusLength;
    var sweepTan = Math.tan(d.sweepLE * Math.PI / 180);
    var macLE = wingRootLE + r.yMac * sweepTan;
    var xC4Mac = macLE + 0.25 * r.mac;
    var xTailC4 = xC4Mac + d.tailArm;
    var t = r.tail;
    // drawing spans/chords per tail type
    var bhDraw, chRoot, chTip, hv, cvRoot, cvTip, gamma = 0;
    if (t.type === 'vtail') {
      gamma = t.gamma;
      bhDraw = t.span * Math.cos(gamma);                 // projected span, top view
      chRoot = t.rootChord; chTip = t.rootChord * d.tailTaper;
      hv = (t.span / 2) * Math.sin(gamma);               // projected height, side view
      cvRoot = t.rootChord; cvTip = chTip;
    } else {
      bhDraw = t.spanH;
      chRoot = t.rootChordH; chTip = t.rootChordH * d.tailTaper;
      hv = t.heightV;
      cvRoot = t.rootChordV; cvTip = t.rootChordV * d.tailTaper;
    }
    return {
      wingRootLE: wingRootLE, sweepTan: sweepTan, macLE: macLE,
      xC4Mac: xC4Mac, xTailC4: xTailC4,
      bhDraw: bhDraw, chRoot: chRoot, chTip: chTip,
      hv: hv, cvRoot: cvRoot, cvTip: cvTip, gamma: gamma,
      xCG: macLE + (d.cgMac / 100) * r.mac,
      xNP: macLE + (r.npMac / 100) * r.mac,
      totalLength: r.totalLength // same placement math as the derived metric
    };
  }

  /* ── top view ────────────────────────────────────────────────────────── */
  function renderTopView(d, r) {
    var L = layout(d, r);
    var W = 640, H = 420, pad = 48;
    var scale = Math.min((W - 2 * pad) / d.span, (H - 2 * pad - 20) / L.totalLength);
    var cx = W / 2;
    var y0 = pad + 10; // nose y
    function X(spanwise) { return cx + spanwise * scale; }
    function Y(x) { return y0 + x * scale; }

    var s = svgOpen(W, H);
    s += '<title>Top view of the configured airframe, to scale</title>';
    // centerline
    s += line(cx, y0 - 8, cx, Y(L.totalLength) + 8, 'uav-centerline');
    // fuselage (simple pod: rounded nose, straight taper aft)
    var fr = d.fusDiameter / 2 * scale;
    s += path('M ' + f2(cx - fr) + ' ' + f2(Y(0.06 * d.fusLength)) +
      ' Q ' + f2(cx - fr) + ' ' + f2(Y(0)) + ' ' + f2(cx) + ' ' + f2(Y(0)) +
      ' Q ' + f2(cx + fr) + ' ' + f2(Y(0)) + ' ' + f2(cx + fr) + ' ' + f2(Y(0.06 * d.fusLength)) +
      ' L ' + f2(cx + fr) + ' ' + f2(Y(0.7 * d.fusLength)) +
      ' L ' + f2(cx + 0.35 * fr) + ' ' + f2(Y(d.fusLength)) +
      ' L ' + f2(cx - 0.35 * fr) + ' ' + f2(Y(d.fusLength)) +
      ' L ' + f2(cx - fr) + ' ' + f2(Y(0.7 * d.fusLength)) + ' Z', 'uav-skin');
    // tail boom if the tail sits behind the fuselage
    var boomEnd = L.xTailC4 + 0.75 * L.chRoot;
    if (boomEnd > d.fusLength) {
      s += line(cx, Y(d.fusLength), cx, Y(boomEnd), 'uav-boom');
    }
    // wing planform
    var half = d.span / 2;
    var rootLE = L.wingRootLE, tipLE = rootLE + half * L.sweepTan;
    s += poly([
      [X(0), Y(rootLE)], [X(half), Y(tipLE)], [X(half), Y(tipLE + r.tipChord)],
      [X(0), Y(rootLE + d.rootChord)], [X(-half), Y(tipLE + r.tipChord)], [X(-half), Y(tipLE)]
    ], 'uav-surface');
    // MAC chord line
    s += line(X(r.yMac), Y(L.macLE), X(r.yMac), Y(L.macLE + r.mac), 'uav-macline');
    s += text(X(r.yMac) + 5, Y(L.macLE + r.mac / 2), 'MAC', 'uav-fig-label');
    // tail planform (projected for a V-tail)
    var thLE = L.xTailC4 - 0.25 * L.chRoot;
    var htHalf = L.bhDraw / 2;
    s += poly([
      [X(0), Y(thLE)], [X(htHalf), Y(thLE + (L.chRoot - L.chTip) / 2)],
      [X(htHalf), Y(thLE + (L.chRoot + L.chTip) / 2)], [X(0), Y(thLE + L.chRoot)],
      [X(-htHalf), Y(thLE + (L.chRoot + L.chTip) / 2)], [X(-htHalf), Y(thLE + (L.chRoot - L.chTip) / 2)]
    ], 'uav-surface');
    if (r.tail.type === 'vtail') {
      s += text(X(htHalf) + 4, Y(thLE + L.chRoot / 2), 'V-tail Γ ' + fmt(L.gamma * 180 / Math.PI, 0) + '°', 'uav-fig-label');
    }
    // CG / NP on centerline
    s += cgSymbol(cx, Y(L.xCG), 6);
    s += '<circle cx="' + f2(cx) + '" cy="' + f2(Y(L.xNP)) + '" r="3.5" class="uav-np"/>';
    s += text(cx + 10, Y(L.xCG) + 3, 'CG', 'uav-fig-label');
    s += text(cx + 10, Y(L.xNP) + 3, 'NP', 'uav-fig-label uav-fig-label-accent');
    // dimensions
    s += dimH(X(-half), X(half), y0 - 2, 'span ' + fmt(d.span, 2) + ' m');
    // vertical dim: fuselage length
    var dx = X(half) + 26;
    s += line(dx, Y(0), dx, Y(d.fusLength), 'uav-dim');
    s += line(dx - 4, Y(0), dx + 4, Y(0), 'uav-dim');
    s += line(dx - 4, Y(d.fusLength), dx + 4, Y(d.fusLength), 'uav-dim');
    s += '<text x="' + f2(dx + 4) + '" y="' + f2(Y(d.fusLength / 2)) + '" class="uav-dim-label" transform="rotate(90 ' + f2(dx + 4) + ' ' + f2(Y(d.fusLength / 2)) + ')" text-anchor="middle">fus ' + fmt(d.fusLength, 2) + ' m</text>';
    s += '</svg>';
    document.getElementById('uav-top-view').innerHTML = s;
  }

  /* ── side view ───────────────────────────────────────────────────────── */
  function renderSideView(d, r) {
    var L = layout(d, r);
    var W = 640, H = 220, pad = 40;
    var finTop = d.fusDiameter + L.hv;
    var scale = Math.min((W - 2 * pad) / L.totalLength, (H - 2 * pad) / (finTop + d.fusDiameter));
    var x0 = pad, yRef = H - pad - d.fusDiameter * 0.5 * scale; // fuselage centerline y
    function X(x) { return x0 + x * scale; }

    var fr = d.fusDiameter / 2 * scale;
    var s = svgOpen(W, H);
    s += '<title>Side view with CG and neutral point positions</title>';
    // fuselage profile
    s += path('M ' + f2(X(0.06 * d.fusLength)) + ' ' + f2(yRef - fr) +
      ' Q ' + f2(X(0)) + ' ' + f2(yRef - fr) + ' ' + f2(X(0)) + ' ' + f2(yRef) +
      ' Q ' + f2(X(0)) + ' ' + f2(yRef + fr) + ' ' + f2(X(0.06 * d.fusLength)) + ' ' + f2(yRef + fr) +
      ' L ' + f2(X(0.65 * d.fusLength)) + ' ' + f2(yRef + fr) +
      ' L ' + f2(X(d.fusLength)) + ' ' + f2(yRef + 0.2 * fr) +
      ' L ' + f2(X(d.fusLength)) + ' ' + f2(yRef - 0.2 * fr) +
      ' L ' + f2(X(0.65 * d.fusLength)) + ' ' + f2(yRef - fr) + ' Z', 'uav-skin');
    var boomEnd = L.xTailC4 + 0.75 * L.chRoot;
    if (boomEnd > d.fusLength) s += line(X(d.fusLength), yRef, X(boomEnd), yRef, 'uav-boom');
    // wing root chord silhouette on top of fuselage
    var wingY = yRef - fr;
    s += poly([
      [X(L.wingRootLE), wingY], [X(L.wingRootLE + d.rootChord), wingY],
      [X(L.wingRootLE + d.rootChord), wingY - Math.max(3, 0.12 * d.rootChord * scale)],
      [X(L.wingRootLE + 0.3 * d.rootChord), wingY - Math.max(4, 0.16 * d.rootChord * scale)],
      [X(L.wingRootLE), wingY - Math.max(2, 0.06 * d.rootChord * scale)]
    ], 'uav-surface');
    // tail surfaces by configuration
    var finBaseLE = L.xTailC4 - 0.25 * L.cvRoot;
    var finTopY = yRef - 0.2 * fr - L.hv * scale;
    if (r.tail.type === 'vtail') {
      // single inclined panel drawn at its projected height
      s += poly([
        [X(finBaseLE), yRef - 0.2 * fr],
        [X(finBaseLE + 0.45 * L.cvRoot), finTopY],
        [X(finBaseLE + 0.45 * L.cvRoot + L.cvTip), finTopY],
        [X(finBaseLE + L.cvRoot), yRef - 0.2 * fr]
      ], 'uav-surface');
      s += text(X(finBaseLE) - 4, finTopY - 5, 'V-tail Γ ' + fmt(L.gamma * 180 / Math.PI, 0) + '°', 'uav-fig-label');
    } else {
      // fin
      s += poly([
        [X(finBaseLE - 0.35 * L.cvRoot), yRef - 0.2 * fr],
        [X(finBaseLE + 0.45 * L.cvRoot), finTopY],
        [X(finBaseLE + 0.45 * L.cvRoot + L.cvTip), finTopY],
        [X(finBaseLE + 1.05 * L.cvRoot), yRef - 0.2 * fr]
      ], 'uav-surface');
      // tailplane chord line: at the fin top for a T-tail, on the fuselage otherwise
      var tpY = r.tail.type === 'ttail' ? finTopY : yRef - 0.15 * fr;
      s += line(X(L.xTailC4 - 0.25 * L.chRoot), tpY, X(L.xTailC4 + 0.75 * L.chRoot), tpY, 'uav-hstab');
      if (r.tail.type === 'ttail') s += text(X(L.xTailC4 + 0.75 * L.chRoot) + 3, tpY + 3, 'T', 'uav-fig-label');
    }
    // CG + NP
    s += cgSymbol(X(L.xCG), yRef, 6);
    s += '<circle cx="' + f2(X(L.xNP)) + '" cy="' + f2(yRef) + '" r="3.5" class="uav-np"/>';
    s += text(X(L.xCG) - 4, yRef + 20, 'CG ' + fmt(d.cgMac, 0) + '%', 'uav-fig-label');
    s += text(X(L.xNP) - 4, yRef - 14, 'NP ' + fmt(r.npMac, 0) + '%', 'uav-fig-label uav-fig-label-accent');
    // tail arm dimension
    s += dimH(X(L.xC4Mac), X(L.xTailC4), H - 14, 'tail arm ' + fmt(d.tailArm, 2) + ' m');
    s += '</svg>';
    document.getElementById('uav-side-view').innerHTML = s;
  }

  /* ── front view ──────────────────────────────────────────────────────── */
  function renderFrontView(d, r) {
    var L = layout(d, r);
    var W = 640, H = 200, pad = 40;
    var half = d.span / 2;
    var tipRise = half * Math.tan(d.dihedral * Math.PI / 180);
    var propR = d.propDiameter * 0.0254 / 2;
    var scale = Math.min((W - 2 * pad) / d.span, (H - 2 * pad) / Math.max(tipRise + d.fusDiameter + L.hv, 2 * propR, 0.2));
    var cx = W / 2, cy = H - pad - Math.max(propR * scale - 10, 0);
    var fr = d.fusDiameter / 2 * scale;

    var s = svgOpen(W, H);
    s += '<title>Front view: dihedral, fuselage section, tail, prop disk</title>';
    // prop disk
    s += '<circle cx="' + f2(cx) + '" cy="' + f2(cy) + '" r="' + f2(propR * scale) + '" class="uav-propdisk"/>';
    // wing panels (thin quadrilaterals along dihedral)
    var t = Math.max(2, 0.04 * d.rootChord * scale);
    s += poly([[cx, cy - fr], [cx + half * scale, cy - fr - tipRise * scale], [cx + half * scale, cy - fr - tipRise * scale - t], [cx, cy - fr - t]], 'uav-surface');
    s += poly([[cx, cy - fr], [cx - half * scale, cy - fr - tipRise * scale], [cx - half * scale, cy - fr - tipRise * scale - t], [cx, cy - fr - t]], 'uav-surface');
    // fuselage section
    s += '<circle cx="' + f2(cx) + '" cy="' + f2(cy) + '" r="' + f2(fr) + '" class="uav-skin"/>';
    // tail by configuration
    if (r.tail.type === 'vtail') {
      var vx = (L.bhDraw / 2) * scale, vy = L.hv * scale; // panel projections
      s += line(cx, cy - fr, cx + vx, cy - fr - vy, 'uav-boom');
      s += line(cx, cy - fr, cx - vx, cy - fr - vy, 'uav-boom');
      s += text(cx + vx + 4, cy - fr - vy + 4, 'V-tail', 'uav-fig-label');
    } else {
      var finH = L.hv * scale;
      s += line(cx, cy - fr, cx, cy - fr - finH, 'uav-boom');
      if (r.tail.type === 'ttail') {
        var htHalf = (L.bhDraw / 2) * scale;
        s += line(cx - htHalf, cy - fr - finH, cx + htHalf, cy - fr - finH, 'uav-hstab');
        s += text(cx + htHalf + 4, cy - fr - finH + 4, 'T-tail', 'uav-fig-label');
      } else {
        var htHalf2 = (L.bhDraw / 2) * scale;
        s += line(cx - htHalf2, cy - fr * 0.4, cx + htHalf2, cy - fr * 0.4, 'uav-hstab');
        s += text(cx + 6, cy - fr - finH + 4, 'fin', 'uav-fig-label');
      }
    }
    // dihedral label
    s += text(cx + half * scale * 0.55, cy - fr - tipRise * scale * 0.55 - 8, 'dihedral ' + fmt(d.dihedral, 1) + '°', 'uav-fig-label', 'middle');
    s += text(cx, cy + propR * scale + 14, 'prop ⌀ ' + fmt(d.propDiameter, 1) + ' in', 'uav-fig-label', 'middle');
    s += '</svg>';
    document.getElementById('uav-front-view').innerHTML = s;
  }

  /* ── airfoil section (NACA-4-digit-style reconstruction) ─────────────── */
  function renderAirfoil(d, r) {
    var foil = r.foil;
    var m = foil.camber / 100, p = Math.max(0.05, foil.camberPos / 100), tt = foil.thickness / 100;
    var W = 640, H = 180, pad = 24;
    var chord = W - 2 * pad, y0 = H * 0.62;
    function yt(x) {
      return 5 * tt * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1015 * x * x * x * x);
    }
    function yc(x) {
      if (m === 0) return 0;
      return x < p ? m / (p * p) * (2 * p * x - x * x) : m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x);
    }
    var up = [], lo = [], cam = [];
    for (var i = 0; i <= 60; i++) {
      var x = i / 60;
      var xc = 0.5 * (1 - Math.cos(Math.PI * x)); // cosine spacing
      var c = yc(xc), t = yt(xc);
      up.push([pad + xc * chord, y0 - (c + t) * chord]);
      lo.push([pad + xc * chord, y0 - (c - t) * chord]);
      cam.push([pad + xc * chord, y0 - c * chord]);
    }
    function pathOf(pts) {
      return pts.map(function (pt, idx) { return (idx ? 'L ' : 'M ') + f2(pt[0]) + ' ' + f2(pt[1]); }).join(' ');
    }
    var s = svgOpen(W, H);
    s += '<title>' + esc(foil.label) + ' section profile</title>';
    s += line(pad, y0, pad + chord, y0, 'uav-macline');
    s += path(pathOf(up) + ' ' + pathOf(lo.slice().reverse()).replace(/^M/, 'L') + ' Z', 'uav-foil');
    if (m > 0) s += path(pathOf(cam), 'uav-camberline');
    s += text(pad, 18, foil.label + ' — t/c ' + fmt(foil.thickness, 1) + ' %, camber ' + fmt(foil.camber, 1) + ' % @ ' + fmt(foil.camberPos, 0) + ' %', 'uav-fig-label');
    s += text(pad, 34, 'cl₀ ' + fmt(foil.cl0, 2) + ' · cl max ' + fmt(foil.clmax, 2) + ' · cd₀ ' + fmt(foil.cd0, 4) + ' · cm ' + fmt(foil.cm, 3), 'uav-fig-label');
    s += '</svg>';
    document.getElementById('uav-airfoil-view').innerHTML = s;
    document.getElementById('uav-airfoil-caption').textContent =
      'FIG 4 — wing section: ' + foil.label + ' (' + foil.use + '). Outline reconstructed from camber/thickness parameters' +
      (d.airfoil.indexOf('naca') === 0 ? '.' : ' — approximate for non-NACA sections; polar data from published low-Re tests.');
  }

  /* ── chart scaffolding ───────────────────────────────────────────────── */
  function niceTicks(min, max, n) {
    var span = max - min;
    if (!(span > 0)) return [min];
    var step = Math.pow(10, Math.floor(Math.log10(span / n)));
    var err = span / n / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var ticks = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  function chartFrame(W, H, M, xmin, xmax, ymin, ymax, xlabel, ylabel) {
    var xt = niceTicks(xmin, xmax, 6), yt2 = niceTicks(ymin, ymax, 5);
    function X(v) { return M.l + (v - xmin) / (xmax - xmin) * (W - M.l - M.r); }
    function Y(v) { return H - M.b - (v - ymin) / (ymax - ymin) * (H - M.t - M.b); }
    var s = '';
    yt2.forEach(function (v) { s += line(M.l, Y(v), W - M.r, Y(v), 'uav-grid'); });
    xt.forEach(function (v) { s += line(X(v), H - M.b, X(v), M.t, 'uav-grid'); });
    s += line(M.l, H - M.b, W - M.r, H - M.b, 'uav-axis');
    s += line(M.l, H - M.b, M.l, M.t, 'uav-axis');
    xt.forEach(function (v) { s += text(X(v), H - M.b + 16, String(v), 'uav-tick', 'middle'); });
    yt2.forEach(function (v) { s += text(M.l - 6, Y(v) + 3, String(v), 'uav-tick', 'end'); });
    s += text((M.l + W - M.r) / 2, H - 6, xlabel, 'uav-axis-label', 'middle');
    s += '<text x="14" y="' + f2((M.t + H - M.b) / 2) + '" class="uav-axis-label" text-anchor="middle" transform="rotate(-90 14 ' + f2((M.t + H - M.b) / 2) + ')">' + esc(ylabel) + '</text>';
    return { svg: s, X: X, Y: Y };
  }

  function seriesPath(pts, X, Y, cls) {
    var dstr = '', pen = false;
    pts.forEach(function (pt) {
      if (!isFinite(pt[1]) || isNaN(pt[1])) { pen = false; return; }
      dstr += (pen ? ' L ' : ' M ') + f2(X(pt[0])) + ' ' + f2(Y(pt[1]));
      pen = true;
    });
    return path(dstr.trim(), cls);
  }

  /* ── power vs airspeed chart ─────────────────────────────────────────── */
  var powerChartCtx = null; // kept for hover lookups

  function renderPowerChart(d, r) {
    var W = 640, H = 340, M = { l: 56, r: 16, t: 18, b: 44 };
    var vMin = Math.max(1, r.vstall * 0.85);
    var vMax = Math.max(2 * r.vLdMax, 1.4 * d.cruiseSpeed, r.vstall * 1.8);
    var pts = [];
    var pMaxSeen = d.maxPower;
    for (var i = 0; i <= 120; i++) {
      var v = vMin + (vMax - vMin) * i / 120;
      var p = powerElecAt(d, r, v);
      pts.push([v, p]);
      if (isFinite(p) && p > pMaxSeen) pMaxSeen = p;
    }
    var yMax = Math.min(pMaxSeen * 1.15, Math.max(d.maxPower * 2.5, 10));
    var fr = chartFrame(W, H, M, vMin, vMax, 0, yMax, 'airspeed (m/s)', 'electrical power (W)');
    var s = svgOpen(W, H) + '<title>Electrical power required vs airspeed, against maximum power</title>' + fr.svg;
    s += '<clipPath id="uav-power-clip"><rect x="' + M.l + '" y="' + M.t + '" width="' + (W - M.l - M.r) + '" height="' + (H - M.t - M.b) + '"/></clipPath>';

    // stall boundary
    s += line(fr.X(r.vstall), fr.Y(0), fr.X(r.vstall), M.t, 'uav-stall-line');
    s += text(fr.X(r.vstall) + 4, M.t + 12, 'stall ' + fmt(r.vstall, 1), 'uav-fig-label uav-fig-label-accent');
    // series: required (solid ink) + available (dashed accent) — dash pattern is
    // the color-independent encoding; both series carry direct labels.
    if (d.maxPower <= yMax) {
      s += line(fr.X(vMin), fr.Y(d.maxPower), fr.X(vMax), fr.Y(d.maxPower), 'uav-series-avail');
      s += text(fr.X(vMax) - 4, fr.Y(d.maxPower) - 6, 'P max ' + fmtInt(d.maxPower) + ' W', 'uav-series-label uav-series-label-accent', 'end');
    }
    s += '<g clip-path="url(#uav-power-clip)">' + seriesPath(pts, fr.X, fr.Y, 'uav-series-req') + '</g>';
    var lastP = pts[pts.length - 1][1];
    var labelY = Math.max(M.t + 12, Math.min(H - M.b - 6, fr.Y(lastP) - 8));
    s += text(fr.X(vMax) - 4, labelY, 'P required', 'uav-series-label', 'end');
    // cruise marker
    var pc = r.cruisePowerE;
    if (isFinite(pc) && pc <= yMax) {
      s += '<circle cx="' + f2(fr.X(d.cruiseSpeed)) + '" cy="' + f2(fr.Y(pc)) + '" r="4" class="uav-marker"/>';
      s += text(fr.X(d.cruiseSpeed) + 7, fr.Y(pc) + 3, 'cruise', 'uav-fig-label');
    }
    s += '<rect class="uav-hover-target" x="' + M.l + '" y="' + M.t + '" width="' + (W - M.l - M.r) + '" height="' + (H - M.t - M.b) + '"/>';
    s += '</svg>';
    var host = document.getElementById('uav-power-chart');
    host.innerHTML = s;
    powerChartCtx = { W: W, H: H, M: M, vMin: vMin, vMax: vMax, yMax: yMax, d: d, r: r, fr: fr, host: host };
    attachPowerHover(host);
  }

  function attachPowerHover(host) {
    var svg = host.querySelector('svg');
    var tip = document.getElementById('uav-chart-tip');
    var cross = null;
    svg.addEventListener('pointermove', function (e) {
      var c = powerChartCtx;
      if (!c) return;
      var rect = svg.getBoundingClientRect();
      var fx = (e.clientX - rect.left) / rect.width * c.W;
      if (fx < c.M.l || fx > c.W - c.M.r) { hide(); return; }
      var v = c.vMin + (fx - c.M.l) / (c.W - c.M.l - c.M.r) * (c.vMax - c.vMin);
      var p = powerElecAt(c.d, c.r, v);
      if (!cross) {
        cross = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        cross.setAttribute('class', 'uav-crosshair');
        svg.appendChild(cross);
      }
      cross.setAttribute('x1', f2(c.fr.X(v))); cross.setAttribute('x2', f2(c.fr.X(v)));
      cross.setAttribute('y1', f2(c.M.t)); cross.setAttribute('y2', f2(c.H - c.M.b));
      cross.style.display = '';
      tip.style.display = 'block';
      tip.textContent = fmt(v, 1) + ' m/s · ' + (isNaN(p) ? 'below stall' :
        'P req ' + fmt(p, 1) + ' W · margin ' + fmt(c.d.maxPower - p, 0) + ' W');
      var hostRect = host.getBoundingClientRect();
      var lx = e.clientX - hostRect.left + 12;
      if (lx > hostRect.width - 190) lx = e.clientX - hostRect.left - 195;
      tip.style.left = lx + 'px';
      tip.style.top = (e.clientY - hostRect.top - 28) + 'px';
    });
    svg.addEventListener('pointerleave', hide);
    function hide() {
      tip.style.display = 'none';
      if (cross) cross.style.display = 'none';
    }
  }

  /* ── drag polar chart ────────────────────────────────────────────────── */
  function renderPolarChart(d, r) {
    var W = 640, H = 340, M = { l: 56, r: 16, t: 18, b: 44 };
    var pts = [];
    for (var i = 0; i <= 80; i++) {
      var cl = r.clMax3D * i / 80;
      pts.push([r.cd0 + r.k * cl * cl, cl]);
    }
    var cdMax = r.cd0 + r.k * r.clMax3D * r.clMax3D;
    var fr = chartFrame(W, H, M, 0, cdMax * 1.05, 0, r.clMax3D * 1.1, 'CD (total)', 'CL');
    var s = svgOpen(W, H) + '<title>Drag polar with cruise and best-glide points</title>' + fr.svg;
    s += seriesPath(pts, fr.X, fr.Y, 'uav-series-req');
    // best L/D tangent point
    var clStar = Math.sqrt(r.cd0 / r.k);
    if (clStar <= r.clMax3D) {
      var cdStar = 2 * r.cd0;
      s += '<circle cx="' + f2(fr.X(cdStar)) + '" cy="' + f2(fr.Y(clStar)) + '" r="4" class="uav-np"/>';
      s += text(fr.X(cdStar) + 7, fr.Y(clStar) + 3, 'L/D max ' + fmt(r.ldMax, 1), 'uav-fig-label uav-fig-label-accent');
    }
    // cruise point
    var cdc = r.cd0 + r.k * r.clCruise * r.clCruise;
    if (r.clCruise <= r.clMax3D) {
      s += '<circle cx="' + f2(fr.X(cdc)) + '" cy="' + f2(fr.Y(r.clCruise)) + '" r="4" class="uav-marker"/>';
      s += text(fr.X(cdc) + 7, fr.Y(r.clCruise) + 3, 'cruise L/D ' + fmt(r.ldCruise, 1), 'uav-fig-label');
    }
    s += text(fr.X(r.cd0) + 4, fr.Y(0) - 8, 'CD₀ ' + fmt(r.cd0, 4), 'uav-fig-label');
    s += '</svg>';
    document.getElementById('uav-polar-chart').innerHTML = s;
  }

  /* ── sensitivity analysis (learning tool) ────────────────────────────── */
  var SENS_METRICS = ['vstall', 'ldMax', 'endurance', 'range', 'roc', 'staticMargin'];

  function renderSensitivity(base) {
    var head = document.getElementById('uav-sens-head');
    var body = document.getElementById('uav-sens-body');
    var hh = '<tr><th>Parameter (+10 %)</th>';
    SENS_METRICS.forEach(function (k) {
      hh += '<th class="num">' + esc(metricByKey[k].label) + '</th>';
    });
    head.innerHTML = hh + '</tr>';

    var html = '';
    GROUPS.forEach(function (g) {
      PARAMS.filter(function (p) { return p.group === g.id && !p.options; }).forEach(function (p) {
        var v = design[p.key];
        // +10% of current value; for a zero value, +10% of the parameter's range
        var dv = v !== 0 ? 0.1 * Math.abs(v) : 0.1 * (p.max - p.min);
        var v2 = Math.min(p.max, v + dv);
        if (v2 === v) return; // pinned at the upper bound — no room to perturb
        var t = {};
        PARAMS.forEach(function (q) { t[q.key] = design[q.key]; });
        t[p.key] = v2;
        var r2 = derive(t);
        html += '<tr><td>' + esc(p.label) + (v === 0 ? ' <span class="desc">(from 0: +10 % of range)</span>' : '') + '</td>';
        SENS_METRICS.forEach(function (k) {
          var b = base[k], n = r2[k];
          var pct = (isFinite(b) && b !== 0 && isFinite(n)) ? 100 * (n - b) / Math.abs(b) : NaN;
          var cls = 'num';
          if (isFinite(pct)) {
            if (Math.abs(pct) >= 5) cls += ' uav-sens-hi';
            else if (Math.abs(pct) < 0.5) cls += ' uav-sens-lo';
          }
          html += '<td class="' + cls + '">' + (isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(1) + ' %' : DASH) + '</td>';
        });
        html += '</tr>';
      });
    });
    body.innerHTML = html;
  }

  /* ── parameter physics reference (generated from the registry) ───────── */
  function renderParamReference() {
    var body = document.getElementById('uav-ref-body');
    var html = '';
    GROUPS.forEach(function (g) {
      PARAMS.filter(function (p) { return p.group === g.id; }).forEach(function (p) {
        html += '<tr><td class="uav-ref-name">' + esc(p.label) + '</td>' +
          '<td class="uav-ref-unit">' + esc(p.unit) + '</td>' +
          '<td class="uav-ref-group">' + esc(g.label) + '</td>' +
          '<td class="desc">' + esc(p.teach || '') + '</td></tr>';
      });
    });
    body.innerHTML = html;
  }

  /* ── design file save / load ─────────────────────────────────────────── */
  function designFile() {
    var params = {};
    PARAMS.forEach(function (p) { params[p.key] = design[p.key]; });
    return {
      schema: SCHEMA,
      name: document.getElementById('uav-design-name').value.trim() || 'unnamed-uav',
      saved: new Date().toISOString(),
      params: params
    };
  }

  function saveDesign() {
    var file = designFile();
    var blob = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase() + '.uav.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setFileStatus('Saved ' + a.download + ' — ' + file.saved);
  }

  // apply a parsed design file to the working design; shared by file load
  // and localStorage restore
  function applyDesignData(data) {
    if (data.schema !== SCHEMA) throw new Error('unknown schema "' + data.schema + '" (expected ' + SCHEMA + ')');
    var applied = 0, skipped = [];
    PARAMS.forEach(function (p) {
      var v = data.params ? data.params[p.key] : undefined;
      if (v === undefined) { skipped.push(p.key); return; }
      if (p.options) {
        if (p.options[v]) { design[p.key] = v; applied++; } else skipped.push(p.key);
      } else {
        v = parseFloat(v);
        if (isFinite(v)) { design[p.key] = Math.min(p.max, Math.max(p.min, v)); applied++; }
        else skipped.push(p.key);
      }
    });
    if (data.name) document.getElementById('uav-design-name').value = String(data.name).slice(0, 60);
    activePreset = { airframe: null, motor: null, battery: null };
    renderPresetStatus();
    return { applied: applied, skipped: skipped };
  }

  function loadDesign(fileObj) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var res = applyDesignData(data);
        designTouched = true;
        syncForm();
        recompute();
        setFileStatus('Loaded "' + (data.name || 'unnamed') + '" — ' + res.applied + ' parameters applied' +
          (res.skipped.length ? ', defaults kept for: ' + res.skipped.join(', ') : ''));
      } catch (err) {
        setFileStatus('Load failed: ' + err.message);
      }
    };
    reader.readAsText(fileObj);
  }

  function setFileStatus(msg) {
    document.getElementById('uav-file-status').textContent = msg;
  }

  /* ── localStorage autosave (device-local; refresh-safe working copy) ───
   * Nothing is stored until the visitor actually edits the design — an
   * untouched page leaves no trace.
   */
  var designTouched = false;

  function autosave() {
    if (!designTouched) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(designFile()));
    } catch (err) {
      /* private browsing or quota — the page still works, just without persistence */
    }
  }

  function restoreAutosave() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      applyDesignData(data);
      designTouched = true;
      setFileStatus('Restored working design "' + (data.name || 'unnamed') + '" autosaved ' +
        (data.saved || 'earlier') + ' in this browser. Reset defaults discards it.');
      return true;
    } catch (err) {
      return false;
    }
  }

  function clearAutosave() {
    try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
  }

  /* ── Monte Carlo design search ───────────────────────────────────────── */
  function mcOptionList() {
    // anything numeric — parameter or derived metric — can be constrained,
    // optimized, or plotted
    var opts = [];
    PARAMS.forEach(function (p) {
      if (!p.options) opts.push({ key: p.key, label: p.label + ' [input, ' + p.unit + ']' });
    });
    METRICS.forEach(function (m) {
      opts.push({ key: m.key, label: m.label + ' [derived, ' + m.unit + ']' });
    });
    return opts;
  }

  function optionHtml(selected) {
    return mcOptionList().map(function (o) {
      return '<option value="' + o.key + '"' + (o.key === selected ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }

  function buildMcVaryTable() {
    var body = document.getElementById('uav-mc-vary-body');
    var html = '';
    PARAMS.forEach(function (p) {
      if (p.options) return;
      html += '<tr>' +
        '<td class="uav-mc-check"><input type="checkbox" data-mc-vary="' + p.key + '" id="mcv-' + p.key + '"></td>' +
        '<td><label for="mcv-' + p.key + '">' + esc(p.label) + '</label> <span class="desc">(' + esc(p.unit) + ')</span></td>' +
        '<td class="num" data-mc-current="' + p.key + '"></td>' +
        '<td><input type="number" data-mc-min="' + p.key + '" step="' + p.step + '" autocomplete="off"></td>' +
        '<td><input type="number" data-mc-max="' + p.key + '" step="' + p.step + '" autocomplete="off"></td>' +
        '</tr>';
    });
    body.innerHTML = html;
    body.addEventListener('change', function (e) {
      var key = e.target.getAttribute('data-mc-vary');
      if (!key) return;
      if (e.target.checked) seedMcRange(key);
    });
  }

  function seedMcRange(key) {
    var p = paramByKey[key];
    var cur = design[key];
    var lo = Math.max(p.min, cur * 0.7), hi = Math.min(p.max, cur * 1.3 || p.min + (p.max - p.min) * 0.1);
    if (cur === 0) { lo = p.min; hi = p.min + 0.3 * (p.max - p.min); }
    var minEl = document.querySelector('[data-mc-min="' + key + '"]');
    var maxEl = document.querySelector('[data-mc-max="' + key + '"]');
    if (!minEl.value) minEl.value = +lo.toFixed(Math.max(3, decimalsOf(p.step)));
    if (!maxEl.value) maxEl.value = +hi.toFixed(Math.max(3, decimalsOf(p.step)));
  }

  function syncMcCurrents() {
    PARAMS.forEach(function (p) {
      if (p.options) return;
      var el = document.querySelector('[data-mc-current="' + p.key + '"]');
      if (el) el.textContent = fmt(design[p.key], decimalsOf(p.step));
    });
  }

  function addConstraintRow(key, min, max) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td><select data-c-key>' + optionHtml(key || 'staticMargin') + '</select></td>' +
      '<td><input type="number" data-c-min step="any" value="' + (min !== undefined ? min : '') + '" autocomplete="off" placeholder="no min"></td>' +
      '<td><input type="number" data-c-max step="any" value="' + (max !== undefined ? max : '') + '" autocomplete="off" placeholder="no max"></td>' +
      '<td class="uav-mc-check"><button type="button" class="tools-button" data-c-remove>remove</button></td>';
    tr.querySelector('[data-c-remove]').addEventListener('click', function () { tr.remove(); });
    document.getElementById('uav-mc-constraints-body').appendChild(tr);
  }

  function readMcConfig() {
    var varied = [];
    document.querySelectorAll('[data-mc-vary]').forEach(function (cb) {
      if (!cb.checked) return;
      var key = cb.getAttribute('data-mc-vary');
      var p = paramByKey[key];
      var lo = parseFloat(document.querySelector('[data-mc-min="' + key + '"]').value);
      var hi = parseFloat(document.querySelector('[data-mc-max="' + key + '"]').value);
      if (!isFinite(lo)) lo = p.min;
      if (!isFinite(hi)) hi = p.max;
      lo = Math.max(p.min, Math.min(lo, hi));
      hi = Math.min(p.max, Math.max(lo, hi));
      varied.push({ key: key, min: lo, max: hi });
    });
    var constraints = [];
    document.querySelectorAll('#uav-mc-constraints-body tr').forEach(function (tr) {
      var key = tr.querySelector('[data-c-key]').value;
      var lo = parseFloat(tr.querySelector('[data-c-min]').value);
      var hi = parseFloat(tr.querySelector('[data-c-max]').value);
      if (!isFinite(lo) && !isFinite(hi)) return;
      constraints.push({ key: key, min: isFinite(lo) ? lo : -Infinity, max: isFinite(hi) ? hi : Infinity });
    });
    return {
      varied: varied,
      constraints: constraints,
      objectiveKey: document.getElementById('uav-mc-objective').value,
      objectiveDir: document.getElementById('uav-mc-direction').value,
      samples: Math.min(100000, Math.max(50, parseInt(document.getElementById('uav-mc-samples').value, 10) || 3000)),
      xKey: document.getElementById('uav-mc-x').value,
      yKey: document.getElementById('uav-mc-y').value
    };
  }

  function valueOf(sampleParams, r, key) {
    if (key in r && typeof r[key] === 'number') return r[key];
    if (key in sampleParams) return sampleParams[key];
    return NaN;
  }

  function runMonteCarlo() {
    var cfg = readMcConfig();
    var statusEl = document.getElementById('uav-mc-status');
    if (!cfg.varied.length) {
      statusEl.textContent = 'Select at least one parameter to vary.';
      return;
    }
    var points = [];
    var best = null;
    var feasible = 0;
    var t0 = performance.now();
    for (var i = 0; i < cfg.samples; i++) {
      var sample = {};
      PARAMS.forEach(function (p) { sample[p.key] = design[p.key]; });
      cfg.varied.forEach(function (vp) {
        var v = vp.min + Math.random() * (vp.max - vp.min);
        if (paramByKey[vp.key].step >= 1) v = Math.round(v);
        sample[vp.key] = v;
      });
      var r = derive(sample);
      var ok = cfg.constraints.every(function (c) {
        var v = valueOf(sample, r, c.key);
        return isFinite(v) && v >= c.min && v <= c.max;
      });
      if (ok) feasible++;
      var obj = valueOf(sample, r, cfg.objectiveKey);
      var px = valueOf(sample, r, cfg.xKey);
      var py = valueOf(sample, r, cfg.yKey);
      // keep the sample itself (when affordable) so scatter axes can be
      // re-projected without re-running the search
      points.push(cfg.samples <= 20000 ? { x: px, y: py, ok: ok, sample: sample } : { x: px, y: py, ok: ok });
      if (ok && isFinite(obj)) {
        if (!best || (cfg.objectiveDir === 'max' ? obj > best.obj : obj < best.obj)) {
          best = { obj: obj, params: sample, derived: r, index: points.length - 1 };
        }
      }
    }
    var ms = performance.now() - t0;
    if (best) points[best.index].best = true;
    mcResult = { cfg: cfg, points: points, best: best, feasible: feasible, ms: ms };
    renderMcResults();
  }

  function renderMcResults() {
    var res = mcResult;
    var statusEl = document.getElementById('uav-mc-status');
    var cfg = res.cfg;
    statusEl.textContent = res.points.length + ' samples in ' + fmt(res.ms, 0) + ' ms · ' +
      res.feasible + ' feasible (' + fmt(100 * res.feasible / res.points.length, 1) + ' %)' +
      (res.best ? ' · best ' + labelFor(cfg.objectiveKey) + ' = ' + fmtMetric(cfg.objectiveKey, res.best.obj) :
        ' · no feasible sample — relax constraints or widen ranges');
    renderMcScatter();
    var bestHost = document.getElementById('uav-mc-best');
    if (!res.best) { bestHost.innerHTML = ''; return; }
    var html = '<table class="tools-ref-table uav-mc-best-table"><thead><tr>' +
      '<th>Varied parameter</th><th class="num">Best sample</th><th class="num">Current design</th></tr></thead><tbody>';
    cfg.varied.forEach(function (vp) {
      var p = paramByKey[vp.key];
      html += '<tr><td>' + esc(p.label) + ' (' + esc(p.unit) + ')</td>' +
        '<td class="num">' + fmt(res.best.params[vp.key], decimalsOf(p.step)) + '</td>' +
        '<td class="num">' + fmt(design[vp.key], decimalsOf(p.step)) + '</td></tr>';
    });
    html += '</tbody></table>' +
      '<div class="tools-controls"><button type="button" class="tools-button primary" id="uav-mc-apply">Apply best sample to design</button></div>';
    bestHost.innerHTML = html;
    document.getElementById('uav-mc-apply').addEventListener('click', function () {
      cfg.varied.forEach(function (vp) {
        design[vp.key] = res.best.params[vp.key];
        notePresetDivergence(vp.key);
      });
      designTouched = true;
      syncForm();
      recompute();
      setFileStatus('Applied Monte Carlo best sample to the working design.');
    });
  }

  function labelFor(key) {
    if (metricByKey[key]) return metricByKey[key].label;
    if (paramByKey[key]) return paramByKey[key].label;
    return key;
  }

  function renderMcScatter() {
    var res = mcResult;
    var host = document.getElementById('uav-mc-scatter');
    if (!res) { host.innerHTML = ''; return; }
    var xs = [], ys = [];
    res.points.forEach(function (p) {
      if (isFinite(p.x) && isFinite(p.y)) { xs.push(p.x); ys.push(p.y); }
    });
    if (!xs.length) { host.innerHTML = ''; return; }
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    if (xmin === xmax) { xmin -= 1; xmax += 1; }
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    var W = 640, H = 360, M = { l: 64, r: 16, t: 18, b: 46 };
    var fr = chartFrame(W, H, M, xmin, xmax, ymin, ymax,
      labelFor(res.cfg.xKey), labelFor(res.cfg.yKey));
    var s = svgOpen(W, H) + '<title>Monte Carlo samples: feasible vs infeasible</title>' + fr.svg;
    // cap the DOM cost: large sample sets are stride-thinned before drawing
    // (every sample was still evaluated; only the plot is thinned)
    var MAX_DRAW = 4000;
    function drawSet(wantOk, radius, cls) {
      var idx = [];
      res.points.forEach(function (p, i) {
        if (p.ok === wantOk && isFinite(p.x) && isFinite(p.y)) idx.push(i);
      });
      var stride = Math.max(1, Math.ceil(idx.length / MAX_DRAW));
      for (var i = 0; i < idx.length; i += stride) {
        var p = res.points[idx[i]];
        s += '<circle cx="' + f2(fr.X(p.x)) + '" cy="' + f2(fr.Y(p.y)) + '" r="' + radius + '" class="' + cls + '"/>';
      }
      return { total: idx.length, drawn: Math.ceil(idx.length / stride) };
    }
    // infeasible under feasible; best on top with a ring
    var inf = drawSet(false, 2, 'uav-pt-infeasible');
    var fea = drawSet(true, 2.5, 'uav-pt-feasible');
    if (res.best) {
      var b = res.points[res.best.index];
      if (isFinite(b.x) && isFinite(b.y)) {
        s += '<circle cx="' + f2(fr.X(b.x)) + '" cy="' + f2(fr.Y(b.y)) + '" r="6" class="uav-pt-best"/>';
        s += text(fr.X(b.x) + 9, fr.Y(b.y) + 3, 'best', 'uav-fig-label');
      }
    }
    // legend (text + swatch, identity not by color alone: shape/size differ too)
    var feaLabel = 'feasible (' + res.feasible + (fea.drawn < fea.total ? ', drawn ' + fea.drawn : '') + ')';
    var infLabel = 'infeasible' + (inf.drawn < inf.total ? ' (drawn ' + inf.drawn + ' of ' + inf.total + ')' : '');
    s += '<circle cx="' + (M.l + 8) + '" cy="' + (M.t + 6) + '" r="2.5" class="uav-pt-feasible"/>';
    s += text(M.l + 16, M.t + 9, feaLabel, 'uav-fig-label');
    var infX = M.l + 26 + feaLabel.length * 6.6;
    s += '<circle cx="' + f2(infX) + '" cy="' + (M.t + 6) + '" r="2" class="uav-pt-infeasible"/>';
    s += text(infX + 8, M.t + 9, infLabel, 'uav-fig-label');
    s += '</svg>';
    host.innerHTML = s;
  }

  /* ── main recompute ──────────────────────────────────────────────────── */
  function recompute() {
    derived = derive(design);
    renderReadouts(derived);
    renderChecks(design, derived);
    renderTopView(design, derived);
    renderSideView(design, derived);
    renderFrontView(design, derived);
    renderAirfoil(design, derived);
    renderPowerChart(design, derived);
    renderPolarChart(design, derived);
    renderSensitivity(derived);
    syncMcCurrents();
    autosave();
  }

  /* ── init ────────────────────────────────────────────────────────────── */
  function init() {
    buildForm();
    buildPresetTables();
    buildMcVaryTable();
    renderParamReference();
    // MC selectors
    document.getElementById('uav-mc-objective').innerHTML = optionHtml('endurance');
    document.getElementById('uav-mc-x').innerHTML = optionHtml('massTotal');
    document.getElementById('uav-mc-y').innerHTML = optionHtml('endurance');
    // prepopulated constraint set: airworthiness rows carry working bounds;
    // logistics/mission rows are blank templates — blank rows are ignored by
    // the solver until a bound is filled in
    addConstraintRow('staticMargin', 4, 20);
    addConstraintRow('thrustWeight', 0.5, undefined);
    addConstraintRow('massTotal');
    addConstraintRow('payload');
    addConstraintRow('span');
    addConstraintRow('totalLength');
    addConstraintRow('vstall');
    addConstraintRow('endurance');

    document.getElementById('uav-save').addEventListener('click', saveDesign);
    document.getElementById('uav-load-input').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) loadDesign(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('uav-reset').addEventListener('click', function () {
      design = defaultDesign();
      activePreset = { airframe: null, motor: null, battery: null };
      designTouched = false;
      clearAutosave();
      renderPresetStatus();
      syncForm();
      recompute();
      setFileStatus('Reset to default trainer-class design. Autosaved copy discarded.');
    });
    document.getElementById('uav-design-name').addEventListener('input', function () {
      designTouched = true;
      autosave();
    });
    document.getElementById('uav-mc-run').addEventListener('click', runMonteCarlo);
    document.getElementById('uav-mc-add-constraint').addEventListener('click', function () {
      addConstraintRow();
    });
    document.getElementById('uav-mc-x').addEventListener('change', function () { if (mcResult) rerunScatterOnly(); });
    document.getElementById('uav-mc-y').addEventListener('change', function () { if (mcResult) rerunScatterOnly(); });

    restoreAutosave();
    syncForm();
    recompute();
  }

  function rerunScatterOnly() {
    var cfg = readMcConfig();
    mcResult.cfg.xKey = cfg.xKey;
    mcResult.cfg.yKey = cfg.yKey;
    if (!mcResult.points.length || !mcResult.points[0].sample) {
      document.getElementById('uav-mc-status').textContent =
        'Axis selection changed — sample set too large to re-project; run the search again.';
      return;
    }
    mcResult.points.forEach(function (p) {
      var r = derive(p.sample);
      p.x = valueOf(p.sample, r, cfg.xKey);
      p.y = valueOf(p.sample, r, cfg.yKey);
    });
    renderMcScatter();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
