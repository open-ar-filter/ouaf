// Malicious filter (#27): a setup that never returns.
export default {
  setup() {
    for (;;) {}
  },
}
