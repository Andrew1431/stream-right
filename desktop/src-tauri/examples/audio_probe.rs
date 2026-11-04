//! Dev harness for the native Go-live audio stage: captures for a few seconds and writes an
//! Ogg Opus file you can play or inspect with ffmpeg.
//!
//! cargo run --example audio_probe -- <app PID | all | off> <seconds> <out.opus> [--child-tone HZ]
//!
//! `--child-tone` starts ffplay playing a sine as a child of this process, which the stage must
//! treat as stream's own tree and leave out in `all` mode. Write the output outside the repo.

use std::io::Write;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use stream_desktop_lib::live::{audio, AudioMode, Clock};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: audio_probe <app PID | all | off> <seconds> <out.opus> [--child-tone HZ]");
        std::process::exit(2);
    }
    let mode = match args[0].as_str() {
        "all" => AudioMode::AllExceptVoice,
        "off" => AudioMode::Off,
        pid => AudioMode::App { pid: pid.parse().expect("pid") },
    };
    let seconds: f64 = args[1].parse().expect("seconds");
    let out = &args[2];
    let child = args.iter().position(|a| a == "--child-tone").map(|i| {
        let hz = &args[i + 1];
        let child = std::process::Command::new("ffplay")
            .args(["-nodisp", "-autoexit", "-loglevel", "quiet", "-f", "lavfi", &format!("sine=f={hz}:d={}", seconds + 3.0)])
            .spawn()
            .expect("ffplay");
        eprintln!("[probe] child tone {hz} Hz, pid {}", child.id());
        std::thread::sleep(Duration::from_millis(800));
        child
    });

    let clock = Clock::start();
    let (tx, rx) = mpsc::sync_channel(256);
    let stage = audio::start(mode, clock, tx).unwrap_or_else(|e| panic!("start failed: {e}"));
    let started = Instant::now();
    let mut packets = Vec::new();
    while started.elapsed().as_secs_f64() < seconds {
        if let Ok(p) = rx.recv_timeout(Duration::from_millis(100)) {
            packets.push(p);
        }
    }
    stage.stop();
    packets.extend(rx.try_iter());
    if let Some(mut c) = child {
        let _ = c.kill();
    }

    let gaps = packets.windows(2).filter(|w| w[1].pts_us != w[0].pts_us + 20_000).count();
    let bytes: usize = packets.iter().map(|p| p.data.len()).sum();
    let secs = packets.len() as f64 * 0.02;
    eprintln!(
        "[probe] {} packets ({secs:.2} s of audio), first pts {} us, {} pts gaps, {:.0} kbps, first packet {} ms after start",
        packets.len(),
        packets.first().map_or(0, |p| p.pts_us),
        gaps,
        if secs > 0.0 { bytes as f64 * 8.0 / secs / 1000.0 } else { 0.0 },
        packets.first().map_or(0, |p| p.pts_us / 1000),
    );
    write_ogg(out, &packets.iter().map(|p| p.data.as_slice()).collect::<Vec<_>>()).expect("write ogg");
    eprintln!("[probe] wrote {out}");
}

fn write_ogg(path: &str, packets: &[&[u8]]) -> std::io::Result<()> {
    const PRE_SKIP: u16 = 312;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let mut head = b"OpusHead".to_vec();
    head.push(1);
    head.push(2);
    head.extend(PRE_SKIP.to_le_bytes());
    head.extend(48_000u32.to_le_bytes());
    head.extend([0, 0, 0]);
    let mut tags = b"OpusTags".to_vec();
    tags.extend(6u32.to_le_bytes());
    tags.extend(b"stream");
    tags.extend(0u32.to_le_bytes());
    let serial = 0x5354_524d;
    let mut seq = 0;
    page(&mut f, serial, &mut seq, 0x02, 0, &head)?;
    page(&mut f, serial, &mut seq, 0, 0, &tags)?;
    for (i, p) in packets.iter().enumerate() {
        let granule = PRE_SKIP as u64 + (i as u64 + 1) * 960;
        page(&mut f, serial, &mut seq, if i + 1 == packets.len() { 0x04 } else { 0 }, granule, p)?;
    }
    f.flush()
}

fn page(f: &mut impl Write, serial: u32, seq: &mut u32, flags: u8, granule: u64, data: &[u8]) -> std::io::Result<()> {
    let mut lacing = vec![255u8; data.len() / 255];
    lacing.push((data.len() % 255) as u8);
    let mut p = b"OggS".to_vec();
    p.push(0);
    p.push(flags);
    p.extend(granule.to_le_bytes());
    p.extend(serial.to_le_bytes());
    p.extend(seq.to_le_bytes());
    p.extend([0; 4]);
    p.push(lacing.len() as u8);
    p.extend(&lacing);
    p.extend(data);
    let crc = crc(&p);
    p[22..26].copy_from_slice(&crc.to_le_bytes());
    *seq += 1;
    f.write_all(&p)
}

fn crc(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04c1_1db7 } else { crc << 1 };
        }
    }
    crc
}
