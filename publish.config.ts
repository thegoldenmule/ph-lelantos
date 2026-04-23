// Publish config — loaded by ph-clint's publish pipeline.
// definePublishConfig is an identity function; a plain export is equivalent.
export default {
  groups: {
    'ph-lelantos': {
      version: '0.1.0',
      packages: [
        { path: 'ph-lelantos-app', category: 'app' },
        { path: 'ph-lelantos-cli', category: 'cli' },
      ],
    },
  },
};
