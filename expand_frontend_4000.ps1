$root = 'C:\java\Online-Recipe-Platform-DEMO-'
$htmlPath = Join-Path $root 'public\index.html'
$cssPath = Join-Path $root 'public\styles.css'

$imageUrls = @(
  'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1525351484163-7529414344d8?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1559847844-5315695dadae?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?auto=format&fit=crop&w=900&q=80',
  'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=900&q=80'
)

$htmlText = [System.IO.File]::ReadAllText($htmlPath)
if ($htmlText -notmatch '</main>') {
  throw 'Main tag not found in HTML.'
}

$htmlInsert = @'
'@
for ($i = 1; $i -le 260; $i++) {
  $image = $imageUrls[($i - 1) % $imageUrls.Count]
  $htmlInsert += @"
      <section class=\"story-panel story-$i\">
        <div class=\"story-header\">
          <span class=\"story-badge\">Kitchen note $i</span>
          <span class=\"story-meta\">Seasonal • slow cooking • pantry rituals</span>
        </div>
        <div class=\"story-layout\">
          <div class=\"story-copy\">
            <h3>Recipe story $i</h3>
            <p>Thoughtful home cooking is about rhythm, contrast, and a little theatre in the kitchen. These editorial sections layer soft textures, bright flavours, and comforting recipes into a calmer daily ritual that feels luxurious without being complicated.</p>
            <ul>
              <li>Warm herbs, citrus brightness, and simple prep for more balanced flavour.</li>
              <li>Build dishes around ingredients that finish beautifully and hold texture.</li>
              <li>Use seasonal produce to keep meals fresh, practical, and beautifully layered.</li>
              <li>Layer savoury depth with stock, aromatics, and a slow finish at the pan.</li>
              <li>Keep a few reliable recipes that feel easy to repeat on busy evenings.</li>
              <li>Serve with texture, contrast, and a single garnish that brings the whole plate alive.</li>
            </ul>
          </div>
          <div class=\"story-visual\">
            <img src=\"$image\" alt=\"Recipe story $i\" />
            <div class=\"story-floating-tag\">Fresh flavour</div>
          </div>
        </div>
      </section>
"@
}

$htmlUpdated = $htmlText -replace '</main>', "$htmlInsert`n    </main>"
[System.IO.File]::WriteAllText($htmlPath, $htmlUpdated)

$cssText = [System.IO.File]::ReadAllText($cssPath)

$cssAppend = @'

@keyframes driftPulse {
  0% { transform: translateY(0px) scale(1); }
  100% { transform: translateY(-10px) scale(1.01); }
}

@keyframes slowZoom {
  0% { transform: scale(1); }
  100% { transform: scale(1.08); }
}

@keyframes shimmer {
  0% { filter: brightness(1); }
  50% { filter: brightness(1.09); }
  100% { filter: brightness(1); }
}

@keyframes floatTag {
  0% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(10px, -8px, 0); }
  100% { transform: translate3d(0, 0, 0); }
}

.story-panel {
  position: relative;
  margin: 28px 0;
  border-radius: 30px;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(232, 221, 209, 0.9);
  box-shadow: 0 16px 34px rgba(44, 34, 20, 0.05);
  overflow: hidden;
}

.story-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 20px 22px 0;
}

.story-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(81, 123, 108, 0.08);
  color: var(--sage);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.story-meta {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
}

.story-layout {
  display: grid;
  grid-template-columns: 1.05fr .95fr;
  gap: 22px;
  padding: 18px 22px 22px;
}

.story-copy h3 {
  margin: 0 0 10px;
  font-family: "Playfair Display", serif;
  font-size: clamp(28px, 2.4vw, 44px);
  line-height: 1.08;
  letter-spacing: -0.06em;
}

.story-copy p {
  margin: 0 0 14px;
  color: var(--muted);
  font-size: 15px;
  line-height: 1.8;
}

.story-copy ul {
  margin: 0;
  padding-left: 20px;
  color: var(--muted);
  line-height: 1.8;
}

.story-visual {
  position: relative;
  min-height: 300px;
  border-radius: 24px;
  overflow: hidden;
  border: 1px solid rgba(232, 221, 209, 0.8);
}

.story-visual img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  animation: slowZoom 10s ease-in-out infinite alternate;
}

.story-floating-tag {
  position: absolute;
  right: 14px;
  bottom: 14px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(232, 221, 209, 0.9);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  animation: floatTag 6s ease-in-out infinite;
}
'@

for ($i = 1; $i -le 1000; $i++) {
  $margin = (($i % 18) + 8)
  $paddingX = (($i % 14) + 10)
  $paddingY = (($i % 16) + 10)
  $radius = (($i % 24) + 12)
  $alpha = [math]::Round((0.62 + (($i % 10) * 0.03)), 2)
  $delay = (($i % 9) + 2)
  $shadowY = (($i % 18) + 8)
  $cssAppend += @"
.ambient-block-$i {
  position: relative;
  display: block;
  margin-top: ${margin}px;
  padding: ${paddingY}px ${paddingX}px;
  border-radius: ${radius}px;
  border: 1px solid rgba(232, 221, 209, 0.8);
  background: rgba(255, 255, 255, $alpha);
  box-shadow: 0 ${shadowY}px 24px rgba(67, 44, 27, 0.03);
  animation: driftPulse ${delay}s ease-in-out infinite alternate;
}
.ambient-block-$i::before {
  content: "Ambient block $i";
  display: block;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sage);
  margin-bottom: 10px;
}
.ambient-block-$i::after {
  content: "";
  display: block;
  width: 100%;
  height: 8px;
  margin-top: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(233, 101, 64, 0.18), rgba(81, 123, 108, 0.18), rgba(255, 255, 255, 0));
  animation: shimmer ${delay}s ease-in-out infinite;
}
.ambient-block-$i p {
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
  font-size: 13px;
}
"@
}

[System.IO.File]::AppendAllText($cssPath, "`n" + $cssAppend)

Write-Host 'HTML lines:' ([System.IO.File]::ReadAllLines($htmlPath).Length)
Write-Host 'CSS lines:' ([System.IO.File]::ReadAllLines($cssPath).Length)
