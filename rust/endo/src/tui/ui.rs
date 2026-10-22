//! Rendering: the single-space panel layout from designs/endor-tui.md
//! § Panel layout (inventory, transcript, pending, command bar).

use ratatui::layout::{Constraint, Direction, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;

use super::state::{App, Connection, Mode, Settlement};

/// Below this width the inventory hides.
const INVENTORY_MIN_TERMINAL_WIDTH: u16 = 60;
/// Below this height the pending region hides when idle.
const PENDING_MIN_TERMINAL_HEIGHT: u16 = 20;

pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let main = if area.width >= INVENTORY_MIN_TERMINAL_WIDTH {
        let inv_width = (area.width / 4).clamp(15, 30);
        let cols = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(inv_width), Constraint::Min(1)])
            .split(area);
        draw_inventory(frame, app, cols[0]);
        cols[1]
    } else {
        area
    };

    let pending_rows = if app.pending.is_empty() && area.height < PENDING_MIN_TERMINAL_HEIGHT {
        0
    } else if app.pending.is_empty() {
        1
    } else {
        app.pending.len().min(5) as u16 + 1
    };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(pending_rows),
            Constraint::Length(3),
        ])
        .split(main);
    draw_header(frame, app, rows[0]);
    draw_transcript(frame, app, rows[1]);
    if pending_rows > 0 {
        draw_pending(frame, app, rows[2]);
    }
    draw_command_bar(frame, app, rows[3]);
}

fn draw_inventory(frame: &mut Frame, app: &App, area: Rect) {
    let mut lines: Vec<Line> = app
        .inventory
        .iter()
        .map(|n| Line::raw(format!(" {n}")))
        .collect();
    lines.push(Line::styled(
        format!(" {} (home)", app.profile),
        Style::default().add_modifier(Modifier::DIM),
    ));
    let block = Block::default().borders(Borders::RIGHT).title(" Inventory");
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let (label, style) = match &app.connection {
        Connection::Live => ("● live".to_string(), Style::default().fg(Color::Green)),
        Connection::Connecting => (
            "◌ connecting".to_string(),
            Style::default().fg(Color::Yellow),
        ),
        Connection::Lost { attempt, retry_ms } => (
            format!(
                "○ daemon lost — retry {attempt} in {:.1}s (:reconnect)",
                *retry_ms as f64 / 1000.0
            ),
            Style::default().fg(Color::White).bg(Color::Red),
        ),
    };
    let line = Line::from(vec![
        Span::styled(
            format!(" {} ", app.profile),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(label, style),
    ]);
    let block = Block::default().borders(Borders::BOTTOM);
    frame.render_widget(Paragraph::new(line).block(block), area);
}

/// Builds transcript lines and reports the line index of the focused
/// message's header, for scrolling.
pub fn transcript_lines(app: &App) -> (Vec<Line<'static>>, Option<usize>) {
    let mut lines = Vec::new();
    let mut focus_line = None;
    for (i, m) in app.messages.iter().enumerate() {
        let focused = app.focus == Some(i);
        if focused {
            focus_line = Some(lines.len());
        }
        let who = match &m.to {
            Some(to) => format!("@{} → @{}", m.from, to),
            None => format!("@{}", m.from),
        };
        let mut head = Style::default().add_modifier(Modifier::BOLD);
        if focused {
            head = head.add_modifier(Modifier::REVERSED);
        }
        lines.push(Line::styled(
            format!(" #{} {}  {}", m.number, m.date, who),
            head,
        ));
        for body in m.body.lines() {
            lines.push(Line::raw(format!("   {body}")));
        }
    }
    (lines, focus_line)
}

fn draw_transcript(frame: &mut Frame, app: &App, area: Rect) {
    let (lines, focus_line) = transcript_lines(app);
    let height = area.height as usize;
    // Stick to the bottom, unless the focused message would scroll off.
    let mut top = lines.len().saturating_sub(height);
    if let Some(f) = focus_line {
        if f < top {
            top = f;
        }
    }
    let p = Paragraph::new(lines).scroll((top.min(u16::MAX as usize) as u16, 0));
    frame.render_widget(p, area);
}

fn draw_pending(frame: &mut Frame, app: &App, area: Rect) {
    let lines: Vec<Line> = app
        .pending
        .iter()
        .rev()
        .take(5)
        .rev()
        .map(|p| match &p.settlement {
            Settlement::Pending => Line::raw(format!(" ◐ {}", p.command)),
            Settlement::Fulfilled(t) => Line::styled(
                format!(" ✓ {} {}", p.command, t),
                Style::default().fg(Color::Green),
            ),
            Settlement::Rejected(t) => Line::styled(
                format!(" ✗ {} — {}", p.command, t),
                Style::default().fg(Color::Red),
            ),
        })
        .collect();
    let block = Block::default().borders(Borders::TOP).title(" Pending ");
    frame.render_widget(Paragraph::new(lines).block(block), area);
}

fn draw_command_bar(frame: &mut Frame, app: &App, area: Rect) {
    let input_line = match (&app.status, app.mode) {
        (Some(s), Mode::Normal) => {
            Line::styled(format!(" {s}"), Style::default().fg(Color::Yellow))
        }
        _ => Line::raw(format!(" {}", app.input)),
    };
    let mut modeline = app.modeline();
    if let (Some(s), Mode::Insert | Mode::Focus) = (&app.status, app.mode) {
        modeline = format!("{s} {modeline}");
    }
    let lines = vec![
        input_line,
        Line::styled(modeline, Style::default().add_modifier(Modifier::DIM)),
    ];
    let block = Block::default().borders(Borders::TOP).title(" Command ");
    frame.render_widget(Paragraph::new(lines).block(block), area);
    if app.mode == Mode::Insert {
        let x = area.x + 1 + app.input.chars().count() as u16;
        frame.set_cursor_position(Position::new(
            x.min(area.right().saturating_sub(1)),
            area.y + 1,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::bus::BusEvent;
    use crate::tui::state::{Key, Message};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn render(app: &App, w: u16, h: u16) -> String {
        let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
        term.draw(|f| draw(f, app)).unwrap();
        let buf = term.backend().buffer().clone();
        let mut s = String::new();
        for y in 0..h {
            for x in 0..w {
                s.push_str(buf[(x, y)].symbol());
            }
            s.push('\n');
        }
        s
    }

    fn sample() -> App {
        let mut app = App::new("@self");
        app.apply(BusEvent::Connected);
        app.apply(BusEvent::InventoryAdded {
            name: "alice".into(),
        });
        app.apply(BusEvent::MessageAdded(Message {
            number: 42,
            date: "2026-04-22 14:03".into(),
            from: "alice".into(),
            to: None,
            body: "Can you take a look?".into(),
        }));
        app
    }

    #[test]
    fn renders_default_layout_at_80x24() {
        let out = render(&sample(), 80, 24);
        assert!(out.contains("Inventory"));
        assert!(out.contains("alice"));
        assert!(out.contains("● live"));
        assert!(out.contains("#42 2026-04-22 14:03  @alice"));
        assert!(out.contains("Can you take a look?"));
        assert!(out.contains("q quit"));
    }

    #[test]
    fn narrow_terminal_hides_inventory() {
        let out = render(&sample(), 50, 24);
        assert!(!out.contains("Inventory"));
        assert!(out.contains("#42"));
    }

    #[test]
    fn lost_connection_banner_keeps_transcript() {
        let mut app = sample();
        app.apply(BusEvent::Disconnected {
            attempt: 3,
            retry_ms: 2000,
        });
        let out = render(&app, 80, 24);
        assert!(out.contains("daemon lost"));
        assert!(out.contains("Can you take a look?"));
    }

    #[test]
    fn pending_region_shows_commands() {
        let mut app = sample();
        for c in "/dismiss 42".chars() {
            app.handle_key(Key::Char(c));
        }
        app.handle_key(Key::Enter);
        let out = render(&app, 80, 24);
        assert!(out.contains("Pending"));
        assert!(out.contains("◐ dismiss 42"));
    }

    #[test]
    fn focused_message_stays_visible() {
        let mut app = sample();
        for n in 43..80 {
            app.apply(BusEvent::MessageAdded(Message {
                number: n,
                date: String::new(),
                from: "bob".into(),
                to: None,
                body: "x".into(),
            }));
        }
        app.handle_key(Key::Char('f'));
        app.handle_key(Key::Char('g'));
        let out = render(&app, 80, 24);
        assert!(out.contains("#42"));
    }
}
