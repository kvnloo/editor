import { NodeId } from './node-id'

export const getCaptureEvidenceTool = {
  name: 'get_capture_evidence',
  title: 'Get capture evidence',
  description:
    'Inspect a scan node capture session without changing the scene. Reports artifact presence and SHA-256 byte checks per stream as pass, fail, or unknown. Missing or inaccessible evidence stays unknown; a matching digest does not establish producer provenance, so the overall verdict remains unknown unless a check fails.',
  input: {
    id: NodeId.describe('The scan node ID whose captureSession should be inspected.'),
  },
}
