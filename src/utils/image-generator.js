import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { getLevel } from '../lang.js';

// Pre-load a standard font if available, or rely on system fonts
try {
  // Try to load Arial or similar system font. If it fails, it will use default.
  // GlobalFonts.registerFromPath('path/to/font.ttf', 'CustomFont');
} catch (e) {}

/**
 * Generate a stats card image for a user.
 */
export async function generateStatsCard(user, stats, badges) {
  const width = 800;
  const height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1e1e2e';
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 20);
  ctx.fill();
  ctx.clip(); // Clip everything else to this rounded rect

  // Decorative header
  ctx.fillStyle = '#f38ba8';
  ctx.fillRect(0, 0, width, 8);

  // Load avatar
  let avatarImage;
  try {
    const avatarUrl = user.displayAvatarURL({ extension: 'png', size: 128 });
    avatarImage = await loadImage(avatarUrl);
  } catch (err) {
    // fallback if no avatar
  }

  // Draw Avatar
  if (avatarImage) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(100, 100, 60, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImage, 40, 40, 120, 120);
    ctx.restore();
    
    // Draw avatar border
    ctx.beginPath();
    ctx.arc(100, 100, 60, 0, Math.PI * 2, true);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#cba6f7';
    ctx.stroke();
  }

  // Text
  ctx.fillStyle = '#cdd6f4';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  ctx.fillText(user.username, width - 40, 70);

  // Stats Text
  const hours = Math.floor(stats.minutes_present / 60);
  const points = stats.points || 0;
  const level = getLevel(stats.minutes_present);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#bac2de';
  ctx.fillText(`الوقت: ${hours} ساعة`, width - 40, 120);
  ctx.fillText(`النقاط: ${points}`, width - 200, 120);
  ctx.fillText(`المستوى: ${level.name} ${level.emoji}`, width - 40, 160);

  // Progress Bar
  const maxHoursForLevel = 100; // Arbitrary max for progress
  const progress = Math.min(hours / maxHoursForLevel, 1);
  
  ctx.fillStyle = '#313244';
  ctx.beginPath();
  ctx.roundRect(width - 400, 190, 360, 20, 10);
  ctx.fill();

  ctx.fillStyle = '#a6e3a1';
  ctx.beginPath();
  ctx.roundRect(width - 400 + 360 * (1 - progress), 190, 360 * progress, 20, 10);
  ctx.fill();

  // Badges
  if (badges && badges.length > 0) {
    ctx.font = '30px sans-serif';
    ctx.textAlign = 'right';
    const emojis = badges.map(b => b.emoji).join(' ');
    ctx.fillText(`الأوسمة: ${emojis}`, width - 40, 260);
  }

  return canvas.toBuffer('image/png');
}
