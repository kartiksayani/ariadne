use super::*;
use tokio::io::AsyncReadExt;

struct Chunks {
    bytes: Vec<u8>,
    offset: usize,
    size: usize,
}
impl AsyncRead for Chunks {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let end = (self.offset + self.size.min(out.remaining())).min(self.bytes.len());
        out.put_slice(&self.bytes[self.offset..end]);
        self.offset = end;
        Poll::Ready(Ok(()))
    }
}
fn reader(bytes: Vec<u8>, size: usize) -> BoundedLines<Chunks> {
    BoundedLines::new(Chunks {
        bytes,
        offset: 0,
        size,
    })
}
#[tokio::test]
async fn split_frames_and_multiple_lines_keep_exact_bytes_and_reset_each_limit() {
    let mut bytes = vec![b'a'; MAX_LINE];
    bytes.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\"}\n");
    bytes.extend_from_slice(&vec![b'b'; MAX_LINE]);
    bytes.push(b'\n');
    let mut output = Vec::new();
    reader(bytes.clone(), 517)
        .read_to_end(&mut output)
        .await
        .unwrap();
    assert_eq!(output, bytes);
}
#[tokio::test]
async fn overflow_poison_closes_without_salvaging_a_following_frame() {
    let mut bytes = vec![b'a'; MAX_LINE + 1];
    bytes.extend_from_slice(b"\n{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\"}\n");
    let mut input = reader(bytes, 4096);
    let mut output = Vec::new();
    assert_eq!(
        input.read_to_end(&mut output).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    let before = output.len();
    assert_eq!(
        input.read_to_end(&mut output).await.unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(output.len(), before);
    assert!(!output.contains(&b'\n'));
}
#[tokio::test]
async fn incomplete_eof_never_dispatches_even_if_a_prefix_is_valid_json() {
    for bytes in [b"{\"partial\":".to_vec(), b"{}".to_vec()] {
        assert_eq!(
            reader(bytes, 1)
                .read_to_end(&mut Vec::new())
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
    let mut empty = Vec::new();
    reader(vec![], 1).read_to_end(&mut empty).await.unwrap();
    assert!(empty.is_empty());
}
